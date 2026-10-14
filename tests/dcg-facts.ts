import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TargetDiagnostic } from '../compiler/diagnostics.ts';
import { Backend, checkedProgram } from '../compiler/backend.ts';
import { resourceReport } from '../compiler/resources.ts';
import { wireLayouts, type RuntimeSchema, type TypeSchema } from '../compiler/schema.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';
import { BEND_COMMIT, compileSbf, prepareBend, run, sbfTools } from '../scripts/build.ts';

type Fixture = {
  tag: number;
  source: string;
  factType: string;
  planType: string;
  accountCount: number;
  instructionBytes: number;
  foldExports: string[];
  roles: string[];
  aliasPolicy: string;
};
type CodecCase = { name: string; input: number[]; capacity: number; expected: number[] | null };
type HandlerResult = {
  tag: number;
  source: string;
  accountCount: number;
  instructionBytes: number;
  accountRoles: string[];
  aliasPolicy: string;
  identitySizingExports: string[];
  foldExports: string[];
  facts: { type: string; wireBytes: number; requestBytes: number; nativeBytes: number };
  plan: { type: string; wireBytes: number; outputCapacityBytes: number; nativeBytes: number };
  foldEnvelopes: { export: string; args: string[]; requestBytes: number; result: string; resultWireBytes: number; resultNativeBytes: number }[];
  largestGeneratedValue: { nativeBytes: number; wireBytes: number };
  compiledFrame: { status: string; bytes?: number; limitBytes?: number; entrypointBytes?: number; source?: string; sourceSha256?: string; functions?: unknown[]; tool: string; reason?: string };
  nativeCases: number;
  malformedCases: string[];
  shortOutputCapacitiesChecked: { fact: number; plan: number };
  bendSchemaTypes: number;
  executedFoldCases: string[];
  compilerIncludeClosure: Record<string, string>;
};

type ToolRecord = { path: string; invokedAs: string; version: string; sha256?: string; binaryFormat?: string; status: 'present' | 'missing' | 'unusable' };
const root = process.cwd();
const canonicalDir = path.resolve('build/dcg-facts');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomUUID()}`;
const outDir = path.join(canonicalDir, 'runs', runId);
const archiveDir = path.join(canonicalDir, 'archive');
const dcgInputsPath = 'tests/dcg-facts/dcg-inputs.json';
const dcgInputDocument = JSON.parse(fs.readFileSync(dcgInputsPath, 'utf8'));
// Only the DCG document/source specification is an input. Older ignored copies
// also contain stale bendSvmMain snapshot metadata; it is deliberately dropped.
const dcgInputs = { dcg: dcgInputDocument.dcg };
let canonicalReportPublishedForRun = false;
const fixtures: Fixture[] = [
  {
    tag: 132, source: 'tests/dcg-facts/tag132.bend', factType: 'Facts132', planType: 'Plan132',
    accountCount: 3, instructionBytes: 33, foldExports: [],
    roles: ['DCR1', 'DCM2', 'DPA1'],
    aliasPolicy: 'DCR1, DCM2, and DPA1 are distinct writable state accounts; no role signs.',
  },
  {
    tag: 131, source: 'tests/dcg-facts/tag131.bend', factType: 'Facts131', planType: 'Plan131',
    accountCount: 10, instructionBytes: 33, foldExports: ['start_fold131', 'fold131_step'],
    roles: ['DCR1', 'DRU1-or-empty', 'ruling-winner', 'executor', 'DCM2', 'incinerator', 'challenger', 'policy-destination', 'remainder-or-System', 'DPA1'],
    aliasPolicy: 'Fixed role order follows the rev-8 pilot plus DPA1 at index 9. Source/state accounts are pairwise distinct. Winner may alias executor or challenger according to ruling. Other recipient aliases follow the versioned role rules and are checked against actual keys.',
  },
  {
    tag: 172, source: 'tests/dcg-facts/tag172.bend', factType: 'Facts172', planType: 'Plan172',
    accountCount: 11, instructionBytes: 33,
    foldExports: ['start_ledger_fold172', 'fold172_ledger_step', 'start_result_fold172', 'fold172_result_step'],
    roles: ['any-signer', 'DCM2', 'DPR2', 'DFS2', 'DCR2-or-DCRZ', 'recorded-payer', 'DTU1', 'auxiliary', 'tail', 'incinerator', 'DPA1'],
    aliasPolicy: 'Fixed role order follows the rev-8 pilot plus DPA1 at index 10. DCM2, DPR2, DFS2, result/tombstone, DTU1, and DPA1 are distinct source accounts. Signer may alias payer/recipient. Source-to-refund aliases are forbidden; policy recipients follow per-policy rules; CUSTOM tail is read-only System Program.',
  },
];

function sha(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function hashFile(file: string): string {
  return sha(fs.readFileSync(file));
}
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}
function git(cwd: string, ...args: string[]): string {
  const p = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (p.error || p.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.error ?? p.stderr}`);
  return p.stdout.trim();
}
function typeMap(schema: RuntimeSchema): Map<string, TypeSchema> {
  return new Map(schema.types.map(t => [t.name, t]));
}
function makeValue(schema: RuntimeSchema, typeName: string, largest = true): WireValue {
  const t = typeMap(schema).get(typeName);
  if (!t) throw new Error(`No generated schema type ${typeName}`);
  if (t.kind === 'u32') return t.max ?? 0xffffffff;
  if (t.kind === 'bool') return true;
  const widths = wireLayouts(schema);
  const variants = t.variants.map(v => ({ variant: v, activeBytes: v.fields.reduce((n, f) => n + widths.get(f.type)!, 0) }));
  variants.sort((a, b) => largest ? b.activeBytes - a.activeBytes : a.activeBytes - b.activeBytes);
  const variant = variants[0].variant;
  return { constructor: variant.name, fields: Object.fromEntries(variant.fields.map(f => [f.name, makeValue(schema, f.type, largest)])) };
}
function record(constructor: string, fields: Record<string, WireValue>): WireValue {
  return { constructor, fields };
}
function u64Value(schema: RuntimeSchema, value: bigint): WireValue {
  return makeRecord(schema, 'U64', { low: Number(value & 0xffffffffn), high: Number((value >> 32n) & 0xffffffffn) });
}
function keyValue(schema: RuntimeSchema, words: number[]): WireValue {
  assert.equal(words.length, 8);
  return makeRecord(schema, 'Key32', Object.fromEntries(words.map((v, i) => [`w${i}`, v])));
}
function makeRecord(schema: RuntimeSchema, typeName: string, fields: Record<string, WireValue>): WireValue {
  const map = typeMap(schema);
  const t = map.get(typeName) ?? map.get(`common.${typeName}`);
  if (!t || t.kind !== 'adt' || t.variants.length !== 1) throw new Error(`${typeName} is not a single-constructor Bend record`);
  return record(t.variants[0].name, fields);
}
function makeVariant(schema: RuntimeSchema, typeName: string, variantName: string): WireValue {
  const map = typeMap(schema);
  const t = map.get(typeName) ?? map.get(`common.${typeName}`);
  if (!t || t.kind !== 'adt') throw new Error(`${typeName} is not an enum`);
  const variant = t.variants.find(v => v.name === variantName || v.name.endsWith(`.${variantName}`));
  if (!variant) throw new Error(`Unknown ${typeName} constructor ${variantName}`);
  return record(variant.name, {});
}
function findLeafOffset(schema: RuntimeSchema, typeName: string, bytes: Uint8Array,
  predicate: (t: TypeSchema) => boolean, base = 0): number | undefined {
  const t = typeMap(schema).get(typeName)!;
  if (predicate(t)) return base;
  if (t.kind !== 'adt') return undefined;
  const variant = t.variants[bytes[base]];
  if (!variant) return undefined;
  let offset = base + 1;
  for (const field of variant.fields) {
    const found = findLeafOffset(schema, field.type, bytes, predicate, offset);
    if (found !== undefined) return found;
    offset += wireLayouts(schema).get(field.type)!;
  }
  return undefined;
}
function findNestedVariantOffset(schema: RuntimeSchema, typeName: string, bytes: Uint8Array,
  base = 0): number | undefined {
  const t = typeMap(schema).get(typeName)!;
  if (t.kind !== 'adt') return undefined;
  if (t.variants.length > 1) return base;
  const variant = t.variants[bytes[base]];
  if (!variant) return undefined;
  let offset = base + 1;
  for (const field of variant.fields) {
    const found = findNestedVariantOffset(schema, field.type, bytes, offset);
    if (found !== undefined) return found;
    offset += wireLayouts(schema).get(field.type)!;
  }
  return undefined;
}
function nativeSource(stem: string): string {
  return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "${path.basename(stem)}.dispatch.h"
int main(void) {
  unsigned length, capacity, byte;
  while (scanf("%u %u", &length, &capacity) == 2) {
    if (length > 1024 || capacity > 1024) return 1;
    unsigned char *input = malloc(length ? length : 1);
    unsigned char *output = malloc(capacity ? capacity : 1);
    if (!input || !output) return 2;
    for (unsigned i = 0; i < length; ++i) {
      if (scanf("%u", &byte) != 1 || byte > 255) return 3;
      input[i] = (unsigned char)byte;
    }
    memset(output, 0xa5, capacity ? capacity : 1);
    unsigned long long written = 777;
    int ok = bend_wire_dispatch(input, length, output, capacity, &written);
    if (!ok && written != 0) return 4;
    printf("%d", ok);
    if (ok) for (unsigned long long i = 0; i < written; ++i) printf(" %u", output[i]);
    puts("");
    free(input); free(output);
  }
  return ferror(stdin) ? 5 : 0;
}
`;
}
function frameSource(stem: string, maxInput: number): string {
  const runtimeHeader = path.relative(path.dirname(stem), path.join(root, 'runtime/solana_min.h')).split(path.sep).join('/');
  if (path.isAbsolute(runtimeHeader) || runtimeHeader.startsWith('../') === false)
    throw new Error('DCG-INCLUDE-CLOSURE: runtime header path is not an explicit relative include');
  return `#include "${runtimeHeader}"
#include "${path.basename(stem)}.dispatch.h"
static u8 output[1024];
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {
  unsigned long long written = 0;
  (void)bend_wire_dispatch(input, ${maxInput}u, output, sizeof(output), &written);
  return written;
}
`;
}
function readNativeLine(binary: string, bytes: Uint8Array, capacity = 1024): { ok: boolean; output: Uint8Array } {
  const input = `${bytes.byteLength} ${capacity} ${[...bytes].join(' ')}\n`;
  const p = spawnSync(path.resolve(binary), [], { encoding: 'utf8', input, maxBuffer: 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr ?? 'native dispatcher failed');
  const items = p.stdout.trim().split(/\s+/).map(Number);
  assert.ok(items.length > 0, 'native dispatcher returned one result line');
  if (items[0] === 0) return { ok: false, output: new Uint8Array() };
  assert.equal(items[0], 1);
  assert.ok(items.slice(1).every(v => Number.isInteger(v) && v >= 0 && v <= 255));
  return { ok: true, output: Uint8Array.from(items.slice(1)) };
}
function callNative(binary: string, codec: ReturnType<typeof wireCodec>, schema: RuntimeSchema,
  name: string, args: WireValue[]): { request: Uint8Array; output: Uint8Array; value: WireValue } {
  const exp = schema.exports.find(e => e.name === name);
  assert.ok(exp, `export ${name} exists`);
  const request = codec.call(name, args);
  const response = readNativeLine(binary, request);
  assert.ok(response.ok, `${name} dispatch succeeds`);
  const value = codec.decode(exp.result, response.output);
  assert.deepEqual(codec.encode(exp.result, value), response.output, `${name} output is canonical`);
  return { request, output: response.output, value };
}
function decodedFields(value: WireValue): Record<string, WireValue> {
  if (!value || typeof value !== 'object' || !('fields' in value)) throw new Error('Expected decoded Bend record');
  return value.fields as Record<string, WireValue>;
}
function makeResultCell(schema: RuntimeSchema, tokenLow: number): WireValue {
  const words = { w0: 0, w1: 0, w2: tokenLow, w3: 0, w4: 0, w5: 0, w6: 0, w7: 0 };
  return makeRecord(schema, 'ResultWindowCell', {
    value: makeRecord(schema, 'CellBytes32', words),
  });
}
function resultWindow(schema: RuntimeSchema, count: number, attestedMask: number, cells: WireValue[]): WireValue {
  assert.equal(cells.length, 8);
  return makeRecord(schema, 'ResultWindow8', {
    meta: makeRecord(schema, 'ResultWindowMeta8', { count, attested_mask: attestedMask }),
    ...Object.fromEntries(cells.map((cell, i) => [`c${i}`, cell])),
  });
}
function settledWindow(schema: RuntimeSchema, count: number, states: string[]): WireValue {
  assert.equal(states.length, 8);
  return makeRecord(schema, 'SettledWindow8', {
    meta: makeRecord(schema, 'WindowMeta8', { count }),
    ...Object.fromEntries(states.map((state, i) => [`c${i}`, makeRecord(schema, 'SettledWindowCell', {
      state: makeVariant(schema, 'OutcomeState', state),
    })])),
  });
}
function outcomeCell(schema: RuntimeSchema, state: string, winner: string, key: WireValue): WireValue {
  const unused = state === 'Unused';
  return makeRecord(schema, 'OutcomeEvidenceCell', {
    state: makeVariant(schema, 'OutcomeState', state), winner: makeVariant(schema, 'Winner', winner), cause: unused ? 0 : 1,
    challenge_bond: u64Value(schema, unused ? 0n : 5n), open_slot: u64Value(schema, unused ? 0n : 10n), ruling_slot: u64Value(schema, unused ? 0n : 11n),
    settlement_slot: u64Value(schema, 0n), challenger_key: unused ? keyValue(schema, Array(8).fill(0)) : key,
  });
}
function runFoldScenarios(fixture: Fixture, schema: RuntimeSchema, codec: ReturnType<typeof wireCodec>, native: string): string[] {
  const done: string[] = [];
  if (fixture.tag === 131) {
    const started = callNative(native, codec, schema, 'start_fold131', [2]);
    let foldWire = started.output;
    let foldValue = started.value;
    const keyA = keyValue(schema, [1, 2, 3, 4, 5, 6, 7, 8]);
    const keyB = keyValue(schema, [9, 10, 11, 12, 13, 14, 15, 16]);
    for (const row of [outcomeCell(schema, 'Open', 'Unset', keyA), outcomeCell(schema, 'Ruled', 'Challenger', keyB)]) {
      const step = makeRecord(schema, 'FoldStep131', { fold: foldValue, row });
      const result = callNative(native, codec, schema, 'fold131_step', [step]);
      assert.deepEqual(result.request.subarray(2, 2 + foldWire.length), foldWire,
        'Rust-style replay encodes the exact Bend-returned fold bytes verbatim');
      foldWire = result.output;
      foldValue = result.value;
    }
    const f = decodedFields(foldValue);
    assert.equal(f.next_sequence, 2);
    assert.equal(f.open_rows, 1);
    assert.equal(f.has_challenger_win, true);
    assert.equal(f.first_challenger_sequence, 1);
    assert.deepEqual(codec.encode('common.Key32', f.first_challenger_key), codec.encode('common.Key32', keyB));
    assert.equal(f.valid, true);
    done.push('tag131-open-and-earliest-challenger-two-step-fold');
    const extra = callNative(native, codec, schema, 'fold131_step', [makeRecord(schema, 'FoldStep131', {
      fold: foldValue, row: outcomeCell(schema, 'Settled', 'Executor', keyA),
    })]);
    const invalid = decodedFields(extra.value);
    assert.equal(invalid.valid, false, 'a row after the fixed target invalidates the fold');
    assert.equal(invalid.next_sequence, 2, 'invalid extra row does not advance the fold cursor');
    done.push('tag131-rejects-row-after-fixed-target');
    const unusedFold = callNative(native, codec, schema, 'start_fold131', [1]);
    const unusedRow = callNative(native, codec, schema, 'fold131_step', [makeRecord(schema, 'FoldStep131', {
      fold: unusedFold.value, row: outcomeCell(schema, 'Unused', 'Unset', keyA),
    })]);
    assert.equal(decodedFields(unusedRow.value).valid, false, 'a row inside the fixed prefix cannot be UNUSED');
    done.push('tag131-rejects-unused-lower-row');
  }
  if (fixture.tag === 172) {
    let ledger = callNative(native, codec, schema, 'start_ledger_fold172', [4]);
    let ledgerWire = ledger.output;
    for (const [count, states] of [
      [2, ['Settled', 'Open', 'Unused', 'Unused', 'Unused', 'Unused', 'Unused', 'Unused']],
      [2, ['Settled', 'Settled', 'Unused', 'Unused', 'Unused', 'Unused', 'Unused', 'Unused']],
    ] as const) {
      const step = makeRecord(schema, 'LedgerFoldStep172', {
        fold: ledger.value, window: settledWindow(schema, count, [...states]),
      });
      const result = callNative(native, codec, schema, 'fold172_ledger_step', [step]);
      assert.deepEqual(result.request.subarray(2, 2 + ledgerWire.length), ledgerWire,
        'ledger accumulator is replayed byte-for-byte from Bend output');
      ledger = { ...result, request: ledger.request };
      ledgerWire = result.output;
    }
    const lf = decodedFields(ledger.value);
    assert.equal(lf.next_sequence, 4);
    assert.equal(lf.unsettled_rows, 1);
    assert.equal(lf.valid, true);
    done.push('tag172-ledger-two-page-fold');
    const oversized = callNative(native, codec, schema, 'fold172_ledger_step', [makeRecord(schema, 'LedgerFoldStep172', {
      fold: ledger.value, window: settledWindow(schema, 9, Array(8).fill('Settled')),
    })]);
    const invalidLedger = decodedFields(oversized.value);
    assert.equal(invalidLedger.valid, false, 'ledger windows larger than eight cells are rejected');
    assert.equal(invalidLedger.next_sequence, 4, 'invalid ledger window does not advance the fold cursor');
    done.push('tag172-rejects-ledger-window-over-eight');

    const binding = makeRecord(schema, 'Drb1Binding', {
      first_output_position: 0, output_count: 10, output_base_entry: 0, output_write: 0,
      output_width: 16, decision_flags: 0, option_count: 0, prompt_positions: 1,
      stop_plus_one: 8, option_table_offset: 0,
    });
    let resultFold = callNative(native, codec, schema, 'start_result_fold172', [makeRecord(schema, 'ResultFoldStart172', {
      binding, landed_positions: 10, output_count: 10, output_width: 16, result_status: 0,
    })]);
    for (const [label, count, mask] of [
      ['nonfinal-partial-window', 2, 3], ['bitmap-high-padding', 8, 256],
    ] as const) {
      const rejected = callNative(native, codec, schema, 'fold172_result_step', [makeRecord(schema, 'ResultFoldStep172', {
        fold: resultFold.value, window: resultWindow(schema, count, mask, Array(8).fill(makeResultCell(schema, 0))),
      })]);
      const invalid = decodedFields(rejected.value);
      assert.equal(invalid.valid, false, label);
      assert.equal(invalid.next_position, 0, `${label}: no cursor advance`);
      done.push(`tag172-rejects-${label}`);
    }
    let resultFoldWire = resultFold.output;
    const pages = [
      [8, 255, [makeResultCell(schema, 0), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0)]],
      [2, 1, [makeResultCell(schema, 7), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0),
        makeResultCell(schema, 0), makeResultCell(schema, 0)]],
    ] as const;
    for (const [count, attestedMask, cells] of pages) {
      if (count === 2) {
        const rejected = callNative(native, codec, schema, 'fold172_result_step', [makeRecord(schema, 'ResultFoldStep172', {
          fold: resultFold.value, window: resultWindow(schema, 2, 5, [...cells]),
        })]);
        assert.equal(decodedFields(rejected.value).valid, false, 'final partial window rejects padding bit 2');
        assert.equal(decodedFields(rejected.value).next_position, 8, 'invalid final window does not advance');
        done.push('tag172-rejects-final-partial-window-padding');
      }
      const step = makeRecord(schema, 'ResultFoldStep172', {
        fold: resultFold.value, window: resultWindow(schema, count, attestedMask, [...cells]),
      });
      const result = callNative(native, codec, schema, 'fold172_result_step', [step]);
      assert.deepEqual(result.request.subarray(2, 2 + resultFoldWire.length), resultFoldWire,
        'result accumulator is replayed byte-for-byte from Bend output');
      resultFold = { ...result, request: resultFold.request };
      resultFoldWire = result.output;
    }
    const rf = decodedFields(resultFold.value);
    assert.equal(rf.next_position, 10);
    assert.equal(rf.expected_prefix_length, 9);
    assert.equal(rf.attested_prefix_count, 9);
    assert.equal(rf.attested_after_prefix_count, 0);
    assert.equal(rf.stop_before_last_count, 0);
    assert.equal(rf.last_value_is_stop, true);
    assert.equal(rf.bitmap_matches_prefix, true);
    assert.equal(rf.valid, true);
    done.push('tag172-final-stop-check-two-page-fold');
    const alreadyFinal = callNative(native, codec, schema, 'start_result_fold172', [makeRecord(schema, 'ResultFoldStart172', {
      binding, landed_positions: 10, output_count: 10, output_width: 16, result_status: 1,
    })]);
    assert.equal(decodedFields(alreadyFinal.value).scan_skipped_final, true,
      'Bend derives the immutable FINAL skip from the validated result status');
    const skippedStep = callNative(native, codec, schema, 'fold172_result_step', [makeRecord(schema, 'ResultFoldStep172', {
      fold: alreadyFinal.value, window: resultWindow(schema, 1, 0, Array(8).fill(makeResultCell(schema, 0))),
    })]);
    assert.equal(decodedFields(skippedStep.value).valid, false, 'a scan window after the Bend-derived FINAL skip is rejected');
    done.push('tag172-final-status-derives-scan-skip');
    done.push('tag172-rejects-window-after-final-skip');
    const malformedWindow = callNative(native, codec, schema, 'fold172_result_step', [makeRecord(schema, 'ResultFoldStep172', {
      fold: resultFold.value, window: resultWindow(schema, 9, 0, Array(8).fill(makeResultCell(schema, 0))),
    })]);
    const invalidResult = decodedFields(malformedWindow.value);
    assert.equal(invalidResult.valid, false, 'result windows larger than eight cells are rejected');
    assert.equal(invalidResult.next_position, 10, 'invalid result window does not advance the fold cursor');
    done.push('tag172-rejects-result-window-over-eight');
    const invalidStart = callNative(native, codec, schema, 'start_result_fold172', [makeRecord(schema, 'ResultFoldStart172', {
      binding: makeRecord(schema, 'Drb1Binding', {
        first_output_position: 0, output_count: 10, output_base_entry: 0, output_write: 0,
        output_width: 0, decision_flags: 0, option_count: 0, prompt_positions: 1,
        stop_plus_one: 8, option_table_offset: 0,
      }), landed_positions: 4, output_count: 4, output_width: 0, result_status: 0,
    })]);
    assert.equal(decodedFields(invalidStart.value).valid, false, 'zero-width result configuration is rejected');
    done.push('tag172-rejects-zero-result-width');
  }
  return done;
}

function nativeBinaryFormat(file: string): string | undefined {
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic, 0, magic.length, 0); } finally { fs.closeSync(fd); }
  if (magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF';
  if (magic.subarray(0, 2).toString('ascii') === 'MZ') return 'PE';
  const value = magic.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(value)) return 'Mach-O';
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(value)) return 'Mach-O universal';
  return undefined;
}
function toolRecord(command: string, args: string[], requireNativeBinary = false): ToolRecord {
  const invokedAs = command.includes(path.sep)
    ? path.resolve(command)
    : spawnSync('which', [command], { encoding: 'utf8' }).stdout?.trim();
  if (!invokedAs || !fs.existsSync(invokedAs)) return { path: command, invokedAs: command, version: 'missing', status: 'missing' };
  const resolved = fs.realpathSync(invokedAs);
  const sha256 = hashFile(resolved);
  const binaryFormat = nativeBinaryFormat(resolved);
  if (requireNativeBinary && !binaryFormat)
    return { path: resolved, invokedAs, version: 'not invoked: executable is not a recognized native binary', sha256, status: 'unusable' };
  const p = spawnSync(invokedAs, args, { encoding: 'utf8' });
  const version = p.error || p.status !== 0
    ? `version-unavailable: ${p.error?.message ?? p.stderr ?? `exit ${p.status}`}`
    : (p.stdout || p.stderr).trim().split('\n')[0];
  const processStartEnoent = p.error?.code === 'ENOENT' && typeof p.error.syscall === 'string' && p.error.syscall.startsWith('spawn');
  const status = processStartEnoent ? 'missing' : p.error || p.status !== 0 ? 'unusable' : 'present';
  return { path: resolved, invokedAs, version, sha256, ...(binaryFormat ? { binaryFormat } : {}), status };
}
function bendIdentity(): { commit: string; trackedTreeSha256: string; status: string } {
  const bendPath = path.resolve('.deps/bend');
  const commit = git(bendPath, 'rev-parse', 'HEAD');
  const status = git(bendPath, 'status', '--porcelain');
  if (commit !== BEND_COMMIT || status) throw new Error('Pinned Bend dependency is not clean at the required commit');
  return { commit, trackedTreeSha256: sha(git(bendPath, 'ls-tree', '-r', '--full-tree', 'HEAD')), status };
}
function dcgIdentityAndHashes(): { repository: string; commit: string; clean: boolean; documentHashes: Record<string, string>; sourceHashes: Record<string, string> } {
  const repository = process.env.DCG_ROOT ?? dcgInputs.dcg.repository;
  const commit = git(repository, 'rev-parse', 'HEAD');
  const status = git(repository, 'status', '--porcelain');
  const clean = status.length === 0;
  assert.equal(commit, dcgInputs.dcg.commit, 'DCG checkout commit matches the recorded specification revision');
  assert.equal(clean, true, 'DCG checkout stays clean while sizing');
  const check = (expected: Record<string, string>) => Object.fromEntries(Object.entries(expected).map(([file, digest]) => {
    const actual = hashFile(path.join(repository, file));
    assert.equal(actual, digest, `current DCG input hash ${file}`);
    return [file, actual];
  }));
  return {
    repository, commit, clean,
    documentHashes: check(dcgInputs.dcg.documents),
    sourceHashes: check(dcgInputs.dcg.currentRevision8Sources),
  };
}
function sourceFiles(): string[] {
  const tracked = [
    ...walkFiles('compiler'), ...walkFiles('runtime'),
    'scripts/build.ts', 'sdk/wire.ts', 'tests/dcg-facts.ts', 'package.json',
    'tests/dcg-facts/common.bend', ...fixtures.map(f => f.source),
    ...walkFiles('tests/dcg-facts').filter(f => f.endsWith('.bend')),
  ];
  const relative = tracked.map(f => path.relative(root, path.resolve(f))).filter(f => !f.startsWith('..'));
  const unique = [...new Set(relative)].sort();
  for (const file of unique) if (!fs.statSync(file).isFile()) throw new Error(`Missing executed input ${file}`);
  return unique;
}
function toolSnapshot(): { hostCompiler: ToolRecord; sbf: Record<string, ToolRecord> } {
  const host = process.env.CC ?? 'clang';
  const toolsPath = sbfTools();
  const sbf = Object.fromEntries(['clang', 'ld.lld', 'llvm-readelf'].map(name => {
    const command = path.join(toolsPath, name);
    return [name, toolRecord(command, ['--version'], true)];
  }));
  return { hostCompiler: toolRecord(host, ['--version']), sbf };
}
function assertSbfToolchain(tools: ReturnType<typeof toolSnapshot>): void {
  for (const [name, tool] of Object.entries(tools.sbf)) {
    if (tool.status !== 'present')
      fail(tool.status === 'missing' ? 'DCG-SBF-TOOL-MISSING' : 'DCG-SBF-TOOL-UNUSABLE',
        `Required SBF tool ${name} is ${tool.status}: ${tool.invokedAs}`, { name, tool });
  }
  const clang = tools.sbf.clang;
  if (!clang.version.includes('20.1.7') || !clang.version.includes('anza-xyz'))
    fail('DCG-SBF-TOOL-VERSION', `Expected Anza platform-tools v1.53 clang 20.1.7; received ${clang.version}`, { clang });
}
function assertHostCompiler(tool: ToolRecord): void {
  if (tool.status !== 'present')
    fail(tool.status === 'missing' ? 'DCG-TOOL-MISSING' : 'DCG-TOOL-UNUSABLE',
      `Required host compiler is ${tool.status}: ${tool.invokedAs}`, { tool });
}
function sourceInventorySha256(files: Record<string, string>): string {
  const canonical = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, digest]) => `${file}\0${digest}\n`).join('');
  return sha(canonical);
}
function containingGitRoot(): string | null {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  try { return fs.realpathSync(result.stdout.trim()); } catch { return null; }
}
function inputSnapshot(): Record<string, any> {
  const files = Object.fromEntries(sourceFiles().map(file => [file, hashFile(file)]));
  files[`config:${dcgInputsPath}#dcg`] = sha(JSON.stringify(dcgInputs.dcg));
  const executable = fs.realpathSync(process.execPath);
  files[`runtime:${executable}`] = hashFile(executable);
  const bend = bendIdentity();
  const sourceRoot = fs.realpathSync(root);
  const gitRoot = containingGitRoot();
  return { sourceRoot, directCheckout: gitRoot === sourceRoot, inventorySha256: sourceInventorySha256(files), files, bend, tools: toolSnapshot() };
}
function assertCapturedInputsUnchanged(before: Record<string, any>, after: Record<string, any>): void {
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => before.files[file] !== after.files[file]);
  if (changed.length)
    fail('DCG-INPUT-DRIFT', `Captured source/runtime inputs changed during sizing: ${changed.join(', ')}`, { changed });
  if (JSON.stringify(before.bend) !== JSON.stringify(after.bend))
    fail('DCG-INPUT-DRIFT', 'Pinned Bend dependency identity changed during sizing');
  if (before.sourceRoot !== after.sourceRoot || before.directCheckout !== after.directCheckout || before.inventorySha256 !== after.inventorySha256)
    fail('DCG-INPUT-DRIFT', 'Captured source root or bound inventory changed during sizing');
  if (JSON.stringify(before.tools) !== JSON.stringify(after.tools)) {
    const changedTools = [...new Set([...Object.keys(before.tools), ...Object.keys(after.tools)])]
      .filter(name => JSON.stringify(before.tools[name]) !== JSON.stringify(after.tools[name]));
    fail('DCG-TOOL-DRIFT', `Captured compiler/tool inputs changed during sizing: ${changedTools.join(', ')}`, { changed: changedTools });
  }
}
function artifactHashes(stems: string[], suffixes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const stem of stems) for (const suffix of suffixes) {
    const file = `${stem}${suffix}`;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) out[path.relative(root, file)] = hashFile(file);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
class ReceiptError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export function receiptError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof ReceiptError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof TargetDiagnostic && error.code === 'BEND-SBF203')
    return { code: 'DCG-SBF-FRAME-OVERFLOW', message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  // Only a structured process-start ENOENT means a tool failed to start.
  // File-system errors (including a missing source) and compiler diagnostics
  // can also contain ENOENT text.
  const processError = error as NodeJS.ErrnoException | null;
  const processStartEnoent = processError?.code === 'ENOENT' &&
    typeof processError.syscall === 'string' && processError.syscall.startsWith('spawn');
  if (processStartEnoent)
    return { code: 'DCG-TOOL-MISSING', message };
  if (/Expected Anza platform-tools v1\.53 clang 20\.1\.7/i.test(message))
    return { code: 'DCG-SBF-TOOL-VERSION', message };
  if (/\bclang failed \(\d+\):[\s\S]*(?:fatal error:|\berror:)/i.test(message))
    return { code: 'DCG-COMPILE-ERROR', message };
  return { code: 'DCG-RUNNER-ERROR', message };
}
function fail(code: string, message: string, details?: unknown): never {
  throw new ReceiptError(code, message, details);
}
function assertNoBuildHeaderShadow(): void {
  const shadow = path.join(root, 'build/solana_min.h');
  try {
    fs.lstatSync(shadow);
    fail('DCG-INCLUDE-SHADOW', `Unexpected build/solana_min.h can shadow runtime/solana_min.h: ${shadow}`);
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fail('DCG-INCLUDE-CLOSURE', `Cannot inspect compiler include shadow path: ${shadow}`, String(error));
  }
}
function makeDependencyPaths(rule: string): string[] {
  const normalized = rule.replace(/\\\r?\n/g, ' ');
  let separator = -1;
  let escaped = false;
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === ':') { separator = index; break; }
  }
  if (separator < 0 || normalized.slice(0, separator).trim() !== 'dcg-sbf-dependencies')
    fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned an invalid dependency rule', { rule });

  const paths: string[] = [];
  let word = '';
  const flush = () => { if (word) paths.push(word); word = ''; };
  for (let index = separator + 1; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === '\\') {
      if (++index >= normalized.length)
        fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned a dangling dependency escape', { rule });
      word += normalized[index];
    } else if (character === '$' && normalized[index + 1] === '$') {
      word += '$'; index++;
    } else if (/\s/.test(character)) flush();
    else word += character;
  }
  flush();
  if (!paths.length) fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned an empty dependency list', { rule });
  return [...new Set(paths)];
}

// This mirrors the full flags array in scripts/build.ts; -M replaces only the
// compile/output action so dependency discovery uses the actual preprocessor
// configuration, including target, optimization, freestanding, and include flags.
const sbfDependencyFlags = ['--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding',
  '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
  '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections', '-fdata-sections', '-Ibuild', '-Iruntime'];
function assertDependencyFlagsMatchBuild(): void {
  const buildSource = fs.readFileSync('scripts/build.ts', 'utf8');
  const match = buildSource.match(/const flags\s*=\s*\[([\s\S]*?)\];/);
  if (!match) fail('DCG-INCLUDE-CLOSURE', 'Cannot find the pinned SBF compiler flags in scripts/build.ts');
  const buildFlags = [...match[1].matchAll(/'([^']+)'/g)].map(found => found[1]);
  if (JSON.stringify(buildFlags) !== JSON.stringify(sbfDependencyFlags))
    fail('DCG-INCLUDE-CLOSURE', 'Clang dependency flags differ from scripts/build.ts', { buildFlags, dependencyFlags: sbfDependencyFlags });
}
function assertCompilerIncludeIdentity(source: string, clang: string, dependencyRule: string): void {
  const trace = spawnSync(clang, [...sbfDependencyFlags, '-H', '-fsyntax-only', source], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (trace.error) throw trace.error;
  if (trace.status !== 0)
    fail('DCG-COMPILE-ERROR', `${clang} include trace failed (${trace.status}): ${trace.stderr ?? ''}`);

  const traced: string[] = [];
  const lines = (trace.stderr ?? '').split(/\r?\n/).filter(line => line.length > 0);
  for (const line of lines) {
    const match = /^(\.+) (.*)$/.exec(line);
    if (!match)
      fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned an unrecognized include trace line', { line });
    const pathname = match[2];
    // -H quotes literal backslashes as doubled backslashes. Treat every such
    // path as unsupported; Make's -M output and Bun's path resolution cannot distinguish it after Clang
    // normalizes that character to a directory separator.
    if (pathname.includes('\\'))
      fail('DCG-INCLUDE-CLOSURE', 'A compiled header name contains a backslash and cannot be represented by the dependency scan', { line, pathname });
    // Keep the trace parser deliberately closed: paths must be printable ASCII
    // without escape syntax so each reported name has one unambiguous spelling.
    if (!/^[\x20-\x7e]+$/.test(pathname))
      fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned a header path outside the supported printable-ASCII grammar', { line, pathname });
    traced.push(pathname);
  }
  if (traced.length === 0)
    fail('DCG-INCLUDE-CLOSURE', 'Pinned Clang returned an empty include trace');

  const rootPath = fs.realpathSync(root);
  const sourcePath = fs.realpathSync(source);
  const dependencies = makeDependencyPaths(dependencyRule).map(dependency =>
    fs.realpathSync(path.isAbsolute(dependency) ? dependency : path.resolve(root, dependency)));
  const dependencyHeaders = new Set(dependencies.filter(file => file !== sourcePath));
  const tracedHeaders = new Set(traced.map(file =>
    fs.realpathSync(path.isAbsolute(file) ? file : path.resolve(root, file))));
  if (dependencyHeaders.size !== tracedHeaders.size || [...dependencyHeaders].some(file => !tracedHeaders.has(file)))
    fail('DCG-INCLUDE-CLOSURE', 'Clang dependency paths do not match its include trace', {
      dependencies: [...dependencyHeaders].map(file => path.relative(rootPath, file).split(path.sep).join('/')).sort(),
      traced: [...tracedHeaders].map(file => path.relative(rootPath, file).split(path.sep).join('/')).sort(),
    });
}
async function compilerIncludeClosure(stem: string): Promise<Record<string, string>> {
  assertNoBuildHeaderShadow();
  assertDependencyFlagsMatchBuild();
  const source = `${stem}.frame.c`;
  const clang = path.join(sbfTools(), 'clang');
  const dependencies = spawnSync(clang, [...sbfDependencyFlags, '-M', '-MT', 'dcg-sbf-dependencies', source], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (dependencies.error) throw dependencies.error;
  if (dependencies.status !== 0)
    fail('DCG-COMPILE-ERROR', `${clang} dependency scan failed (${dependencies.status}): ${dependencies.stderr ?? ''}`);
  assertCompilerIncludeIdentity(source, clang, dependencies.stdout ?? '');

  const hashes: Record<string, string> = {};
  const rootPath = fs.realpathSync(root);
  for (const dependency of makeDependencyPaths(dependencies.stdout ?? '')) {
    const resolved = fs.realpathSync(path.isAbsolute(dependency) ? dependency : path.resolve(root, dependency));
    if (!fs.statSync(resolved).isFile())
      fail('DCG-INCLUDE-CLOSURE', `Clang dependency is not a regular file: ${resolved}`);
    const relative = path.relative(rootPath, resolved);
    const key = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : resolved.split(path.sep).join('/');
    hashes[key] = hashFile(resolved);
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
function archiveExistingSuccess(file: string, label: string): void {
  let original: Buffer;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail('DCG-ARCHIVE-CONFLICT', `Prior success is not a regular file and cannot be archived: ${file}`);
    original = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('DCG-ARCHIVE-CONFLICT', `Cannot read prior success before archive: ${file}`, String(error));
  }
  const digest = sha(original);
  const archive = path.join(archiveDir, `${label}-${runId}.json`);
  const temp = `${archive}.tmp-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, archive);
    if (hashFile(archive) !== digest || !fs.readFileSync(archive).equals(original))
      fail('DCG-ARCHIVE-CONFLICT', `Archived prior success failed byte verification: ${archive}`);
    const stillCurrent = fs.readFileSync(file);
    if (!stillCurrent.equals(original))
      fail('DCG-ARCHIVE-CONFLICT', `Prior success changed while it was being archived: ${file}`);
    fs.unlinkSync(file);
    try {
      const dirFd = fs.openSync(archiveDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is platform dependent */ }
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original even if cleanup is unavailable */ }
    if (error instanceof ReceiptError) throw error;
    fail('DCG-ARCHIVE-CONFLICT', `Could not archive prior success; original remains at ${file}`, String(error));
  }
}
function atomicallyWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* retain the triggering error */ }
    throw error;
  }
}
function atomicallyPublishCanonical(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('DCG-PUBLISH-CONFLICT', `A canonical success report appeared during this run and was preserved: ${file}`);
    fail('DCG-PUBLISH-FAILED', `Could not atomically publish canonical success: ${file}`, String(error));
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* a linked canonical report remains valid */ }
  }
}

async function checkFixture(fixture: Fixture, measureCompilerIncludes: boolean): Promise<{ result: HandlerResult; generatedInputHashesBefore: Record<string, string>; includeClosureHashesBefore: Record<string, string>; artifactOutputs: Record<string, string> }> {
  const checked = await checkedProgram(fixture.source);
  const exports = ['identity_facts', 'identity_plan', ...fixture.foldExports];
  const emitted = new Backend(checked.book).emit(exports);
  const stem = path.join(outDir, `dcg-tag-${fixture.tag}`);
  writeArtifacts(stem, emitted);
  const schema = emitted.schema;
  const types = typeMap(schema);
  const codec = wireCodec(schema);
  const report = resourceReport(schema);
  const nativeByType = new Map(report.layouts.map(v => [v.type, v.nativeBytes]));
  const layouts = wireLayouts(schema);
  const factExport = schema.exports.find(e => e.name === 'identity_facts')!;
  const planExport = schema.exports.find(e => e.name === 'identity_plan')!;
  const factType = factExport.args[0];
  const planType = planExport.args[0];
  assert.equal(factType, fixture.factType, `tag ${fixture.tag} fact root type`);
  assert.equal(planType, fixture.planType, `tag ${fixture.tag} plan root type`);

  const factValue = makeValue(schema, factType);
  const planValue = makeValue(schema, planType);
  const factInput = codec.call('identity_facts', [factValue]);
  const planInput = codec.call('identity_plan', [planValue]);
  const factWire = codec.encode(factType, factValue);
  const planWire = codec.encode(planType, planValue);
  const foldEnvelopes = schema.exports.filter(e => fixture.foldExports.includes(e.name)).map(e => ({
    export: e.name,
    args: [...e.args],
    requestBytes: 1 + e.args.reduce((n, t) => n + layouts.get(t)!, 0),
    result: e.result,
    resultWireBytes: layouts.get(e.result)!,
    resultNativeBytes: nativeByType.get(e.result)!,
  }));
  assert.deepEqual(codec.encode(factType, codec.decode(factType, factWire)), factWire);
  assert.deepEqual(codec.encode(planType, codec.decode(planType, planWire)), planWire);
  assert.deepEqual(codec.encode(factType, codec.reply('identity_facts', factWire)), factWire);
  assert.deepEqual(codec.encode(planType, codec.reply('identity_plan', planWire)), planWire);

  const cases: CodecCase[] = [
    { name: 'decision-facts-identity-largest-constructor-roundtrip', input: [...factInput], capacity: 1024, expected: [...factWire] },
    { name: 'plan-identity-largest-constructor-roundtrip', input: [...planInput], capacity: 1024, expected: [...planWire] },
  ];
  for (const [name, input, outputSize] of [
    ['facts', factInput, layouts.get(factType)!] as const,
    ['plan', planInput, layouts.get(planType)!] as const,
  ]) {
    for (let capacity = 0; capacity < outputSize; capacity++) {
      cases.push({ name: `${name}-short-output-${capacity}`, input: [...input], capacity, expected: null });
    }
  }
  const malformed = (name: string, input: Uint8Array) => cases.push({ name, input: [...input], capacity: 1024, expected: null });
  malformed('truncated-facts', factInput.subarray(0, factInput.length - 1));
  malformed('trailing-facts-byte', Uint8Array.from([...factInput, 0]));
  const badOpcode = factInput.slice(); badOpcode[0] = 255; malformed('unknown-export', badOpcode);
  const badTopTag = factInput.slice(); badTopTag[1] = 255; malformed('invalid-facts-constructor', badTopTag);
  const boolOffset = findLeafOffset(schema, factType, factWire, t => t.kind === 'bool');
  if (boolOffset !== undefined) {
    const badBool = factInput.slice(); badBool[1 + boolOffset] = 2; malformed('invalid-nested-bool', badBool);
    assert.throws(() => codec.decode(factType, Uint8Array.from(badBool.slice(1))));
  }
  const nestedTagOffset = findNestedVariantOffset(schema, factType, factWire);
  assert.notEqual(nestedTagOffset, undefined, `tag ${fixture.tag} fixture has a nested enum`);
  const badNestedTag = factInput.slice(); badNestedTag[1 + nestedTagOffset!] = 255; malformed('invalid-nested-constructor', badNestedTag);
  assert.throws(() => codec.decode(factType, Uint8Array.from(badTopTag.slice(1))));
  assert.throws(() => codec.decode(factType, Uint8Array.from(badNestedTag.slice(1))));

  fs.writeFileSync(`${stem}.schema.json`, JSON.stringify(schema, null, 2) + '\n');
  fs.writeFileSync(`${stem}.vectors.json`, JSON.stringify(cases, null, 2) + '\n');
  fs.writeFileSync(`${stem}.native.c`, nativeSource(stem));
  const maxInput = Math.max(...schema.exports.map(e => 1 + e.args.reduce((n, t) => n + layouts.get(t)!, 0)));
  fs.writeFileSync(`${stem}.frame.c`, frameSource(stem, maxInput));
  const includeClosureHashesBefore = measureCompilerIncludes ? await compilerIncludeClosure(stem) : {};
  const generatedInputSuffixes = ['.h', '.wire.h', '.dispatch.h', '.resources.json', '.schema.json', '.vectors.json', '.native.c', '.frame.c'];
  const generatedInputHashesBefore = artifactHashes([stem], generatedInputSuffixes);
  run(process.env.CC ?? 'clang', ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', `${stem}.native.c`, '-o', `${stem}.native`]);
  const input = cases.map(c => `${c.input.length} ${c.capacity} ${c.input.join(' ')}`).join('\n') + '\n';
  const native = spawnSync(path.resolve(`${stem}.native`), [], { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(native.status, 0, `${native.stderr ?? ''}`);
  const expectedLines = cases.map(c => c.expected === null ? '0' : `1 ${c.expected.join(' ')}`);
  assert.deepEqual(native.stdout.trim().split('\n'), expectedLines, `tag ${fixture.tag} generated native round trips and malformed gate`);
  const executedFoldCases = runFoldScenarios(fixture, schema, codec, `${stem}.native`);

  const frame: HandlerResult['compiledFrame'] = { status: 'not-run', tool: path.join(sbfTools(), 'clang'),
    reason: 'Native codec and fold gates run before the required SBF frame pass.' };
  assert.ok(report.largestNativeBytes <= 1536, `tag ${fixture.tag} native ${report.largestNativeBytes}/1536`);
  assert.ok(report.largestWireBytes <= 1024, `tag ${fixture.tag} wire ${report.largestWireBytes}/1024`);
  assert.ok(1 + layouts.get(factType)! <= 1024, `tag ${fixture.tag} encoded fact request <=1024`);
  assert.ok(layouts.get(planType)! <= 1024, `tag ${fixture.tag} encoded plan <=1024`);
  const generatedInputHashesAfter = artifactHashes([stem], generatedInputSuffixes);
  assert.deepEqual(generatedInputHashesAfter, generatedInputHashesBefore, `tag ${fixture.tag} generated compiler inputs did not drift during builds`);
  const artifactOutputs = artifactHashes([stem], ['.native', '.so', '.stack.json']);

  return {
    result: {
      tag: fixture.tag, source: fixture.source, accountCount: fixture.accountCount,
      instructionBytes: fixture.instructionBytes, accountRoles: fixture.roles, aliasPolicy: fixture.aliasPolicy,
      identitySizingExports: ['identity_facts', 'identity_plan'], foldExports: fixture.foldExports,
      facts: { type: factType, wireBytes: layouts.get(factType)!, requestBytes: 1 + layouts.get(factType)!, nativeBytes: nativeByType.get(factType)! },
      plan: { type: planType, wireBytes: layouts.get(planType)!, outputCapacityBytes: layouts.get(planType)!, nativeBytes: nativeByType.get(planType)! },
      foldEnvelopes,
      largestGeneratedValue: { nativeBytes: report.largestNativeBytes, wireBytes: report.largestWireBytes },
      compiledFrame: frame, nativeCases: cases.length, malformedCases: cases.filter(c => c.expected === null && !c.name.includes('-short-output-')).map(c => c.name),
      shortOutputCapacitiesChecked: { fact: layouts.get(factType)!, plan: layouts.get(planType)! }, bendSchemaTypes: schema.types.length,
      executedFoldCases, compilerIncludeClosure: includeClosureHashesBefore,
    }, generatedInputHashesBefore, includeClosureHashesBefore, artifactOutputs,
  };
}

function currentArtifactOutputs(): Record<string, string> {
  const stems = fixtures.map(f => path.join(outDir, `dcg-tag-${f.tag}`));
  return artifactHashes(stems, ['.native', '.o', '.so', '.stack.json', '.su', '.memory.o', '.memory.su']);
}
async function main(): Promise<void> {
  const nativeOnly = process.argv.includes('--native-only');
  const recordReport = process.argv.includes('--record-report');
  assert.ok(!recordReport || !nativeOnly, '--record-report requires the complete SBF acceptance path');

  fs.mkdirSync(canonicalDir, { recursive: true });
  canonicalReportPublishedForRun = false;
  archiveExistingSuccess(path.join(canonicalDir, 'report.json'), 'report');
  if (recordReport) archiveExistingSuccess(path.resolve('tests/dcg-facts/sizing-report.json'), 'sizing-report');
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.mkdirSync(outDir, { recursive: false });
  assertNoBuildHeaderShadow();
  const artifactOutputSha256Before = currentArtifactOutputs();

  const dcgBefore = dcgIdentityAndHashes();
  const inputBefore = inputSnapshot();
  assertHostCompiler((inputBefore as any).tools.hostCompiler);
  if (!nativeOnly) assertSbfToolchain((inputBefore as any).tools);
  prepareBend();
  const handlers: HandlerResult[] = [];
  const generatedInputs: Record<string, Record<string, string>> = {};
  const generatedInputsAfter: Record<string, Record<string, string>> = {};
  const includeClosures: Record<string, Record<string, string>> = {};
  const includeClosuresAfter: Record<string, Record<string, string>> = {};
  const artifactOutputs: Record<string, string> = {};
  for (const fixture of fixtures) {
    const checked = await checkFixture(fixture, !nativeOnly);
    handlers.push(checked.result);
    generatedInputs[`tag${fixture.tag}`] = checked.generatedInputHashesBefore;
    includeClosures[`tag${fixture.tag}`] = checked.includeClosureHashesBefore;
    Object.assign(artifactOutputs, checked.artifactOutputs);
    console.log(`tag ${fixture.tag}: fact ${checked.result.facts.wireBytes} wire/${checked.result.facts.nativeBytes} native, plan ${checked.result.plan.wireBytes} wire/${checked.result.plan.nativeBytes} native; native codec/fold checks complete, SBF frame pending`);
  }
  const sbfErrors: { tag: number; code: string; message: string }[] = [];
  if (!nativeOnly) {
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      const stem = path.join(outDir, `dcg-tag-${fixture.tag}`);
      try {
        const built = compileSbf(`${stem}.frame.c`, `${stem}.frame`);
        const stack = JSON.parse(fs.readFileSync(`${stem}.frame.stack.json`, 'utf8'));
        const expectedSource = `dcg-tag-${fixture.tag}.frame.c`;
        const frameSource = `${stem}.frame.c`;
        const expectedRawEntrypoint = `${path.relative(root, frameSource).split(path.sep).join('/')}:4:entrypoint`;
        const rawUsage = fs.readFileSync(`${stem}.frame.su`, 'utf8').trim().split(/\r?\n/).filter(Boolean)
          .map(line => line.split('\t', 3));
        const rawEntrypoints = rawUsage.filter(([location]) => location?.endsWith(':entrypoint'));
        const entrypoints = Array.isArray(stack.functions) ? stack.functions.filter((fn: any) =>
          fn.location === `${expectedSource}:4:entrypoint`) : [];
        const measuredMaximum = Array.isArray(stack.functions)
          ? Math.max(0, ...stack.functions.map((fn: any) => Number.isInteger(fn.bytes) && fn.bytes >= 0 ? fn.bytes : 0))
          : 0;
        if (stack.frameLimit !== 4096 || !Number.isInteger(stack.maxFrameBytes) || stack.maxFrameBytes <= 0 ||
            stack.maxFrameBytes !== measuredMaximum || entrypoints.length !== 1 || !Number.isInteger(entrypoints[0].bytes) || entrypoints[0].bytes <= 0 ||
            rawEntrypoints.length !== 1 || rawEntrypoints[0][0] !== expectedRawEntrypoint || !/^\d+$/.test(rawEntrypoints[0][1] ?? '') || Number(rawEntrypoints[0][1]) !== entrypoints[0].bytes)
          fail('DCG-SBF-STACK-USAGE', `tag ${fixture.tag} lacks nonzero stack usage for ${expectedSource}`, { stack });
        if (stack.maxFrameBytes > 4096)
          fail('DCG-SBF-FRAME-OVERFLOW', `tag ${fixture.tag} frame ${stack.maxFrameBytes}/4096`);
        handlers[i].compiledFrame = { status: 'measured', bytes: stack.maxFrameBytes, limitBytes: stack.frameLimit,
          entrypointBytes: entrypoints[0].bytes, source: path.relative(root, frameSource), sourceSha256: hashFile(frameSource),
          functions: stack.functions, tool: path.join(built.tools, 'clang') };
      } catch (error) {
        const diagnostic = receiptError(error);
        if (diagnostic.code === 'DCG-COMPILE-ERROR') diagnostic.code = 'DCG-SBF-COMPILE-ERROR';
        if (diagnostic.code === 'DCG-TOOL-MISSING') diagnostic.code = 'DCG-SBF-TOOL-MISSING';
        sbfErrors.push({ tag: fixture.tag, code: diagnostic.code, message: diagnostic.message });
        handlers[i].compiledFrame = { status: 'failed', tool: path.join(sbfTools(), 'clang'), reason: `[${diagnostic.code}] ${diagnostic.message}` };
      }
      Object.assign(artifactOutputs, artifactHashes([`${stem}.frame`], ['.o', '.so', '.stack.json', '.su', '.memory.o', '.memory.su']));
    }
  }
  for (const fixture of fixtures) {
    const stem = path.join(outDir, `dcg-tag-${fixture.tag}`);
    const closureAfter = nativeOnly ? {} : await compilerIncludeClosure(stem);
    if (JSON.stringify(closureAfter) !== JSON.stringify(includeClosures[`tag${fixture.tag}`]))
      fail('DCG-INPUT-DRIFT', `tag ${fixture.tag} compiler include closure changed after capture`, { before: includeClosures[`tag${fixture.tag}`], after: closureAfter });
    const generatedAfter = artifactHashes([stem], ['.h', '.wire.h', '.dispatch.h', '.resources.json', '.schema.json', '.vectors.json', '.native.c', '.frame.c']);
    if (JSON.stringify(generatedAfter) !== JSON.stringify(generatedInputs[`tag${fixture.tag}`]))
      fail('DCG-INPUT-DRIFT', `tag ${fixture.tag} generated compiler input changed after capture`, { before: generatedInputs[`tag${fixture.tag}`], after: generatedAfter });
    includeClosuresAfter[`tag${fixture.tag}`] = closureAfter;
    generatedInputsAfter[`tag${fixture.tag}`] = generatedAfter;
  }
  const inputAfter = inputSnapshot();
  assertCapturedInputsUnchanged(inputBefore as any, inputAfter as any);
  const dcgAfter = dcgIdentityAndHashes();
  if (JSON.stringify(dcgAfter) !== JSON.stringify(dcgBefore))
    fail('DCG-INPUT-DRIFT', 'DCG checkout and specified document/source inputs changed during sizing');
  Object.assign(artifactOutputs, currentArtifactOutputs());
  const sbfComplete = !nativeOnly && handlers.every(h => h.compiledFrame.status === 'measured');
  const result = {
    format: 'bendSVM-dcg-revision9-fact-sizing-v3',
    runId, artifactRoot: path.relative(root, outDir),
    status: nativeOnly ? 'provisional-native-only' : sbfComplete ? 'complete' : 'failed-sbf-build',
    acceptance: nativeOnly ? 'incomplete: native codec/fold gates only; no SBF frame acceptance' : sbfComplete ? 'complete: all three generated SBF wrapper frames measured' : 'failed: required SBF frame acceptance did not complete',
    classification: 'typed decision-fact/plan identity sizing plus separately executed Bend fold exports; no tag 132/131/172 decision function, Rust handler, account validator, or deployed DCG protocol behavior is implemented',
    inputs: {
      dcg: { ...dcgAfter, expectedCommit: dcgInputs.dcg.commit },
      bendSvmExecution: {
        sourceRoot: inputBefore.sourceRoot,
        directCheckout: inputBefore.directCheckout,
        inventorySha256Before: inputBefore.inventorySha256,
        inventorySha256After: inputAfter.inventorySha256,
        sourceHashesBefore: inputBefore,
        sourceHashesAfter: inputAfter,
      },
      bendDependency: (inputBefore as any).bend,
      buildTools: (inputBefore as any).tools,
      generatedCompilerInputs: generatedInputs,
      generatedCompilerInputsAfter: generatedInputsAfter,
      compilerIncludeClosure: includeClosures,
      compilerIncludeClosureAfter: includeClosuresAfter,
    },
    artifactOutputSha256: artifactOutputs,
    artifactOutputSha256Before,
    artifactOutputSha256After: artifactOutputs,
    trustBoundary: {
      sbfTools: 'SBF compiler, linker, and reader must be native binaries; the Anza clang version is checked, and each resolved path and binary hash is recorded for drift detection. Native magic, version, path, and hash do not establish expected compiler identity because no trusted expected tool hash is checked. These tools are trusted inputs, not semantically verified; a hash identifies bytes and does not prove a malicious native tool correct. Compiler include hashes come from a separate Clang dependency scan that is rechecked before and after compilation; this does not prove that a file was not replaced transiently during compilation and restored before the second scan. Printed header names containing backslashes are explicitly rejected before path resolution: Clang -M and Bun 1.4.2 can both normalize them to slash paths, so the -M/-H set comparison alone does not protect their identity. Symlink targets are hashed through the resolved bytes and may still have backslashes in recorded keys; do not re-resolve those keys through Bun to infer identity. The filesystem and path resolution, Clang and host compiler tools, Python used for separate refinement checks, and the Node/Bun runtime remain trusted inputs.',
    },
    limits: { canonicalWireBytes: 1024, nativeValueBytes: 1536, compiledFrameBytes: 4096, frameScope: 'generated Bend dispatcher/codec identity plus exported folds and static 1024-byte output buffer; excludes Rust caller frame', callerFrame: 'separate and unmeasured', maximumDpa1WindowRows: 8, maximumResultWindowCells: 8 },
    proposedRevision9Records: {
      dpa1HeaderBytes: 304, dpa1RowBytes: 80, challengeLimitMaximum: 1024,
      dpa1MaximumAccountBytes: 304 + 80 * 1024,
      dpa1MaximumWholeLedgerBytesCanFitInOneFact: false,
      dpa1FoldWindows: { tag131FullEvidenceRowsPerWindow: 1, tag131MaximumLowerPrefixWindows: 1023, tag172SettledRowsPerWindow: 8, tag172MaximumLedgerWindows: Math.ceil(1024 / 8) },
      resultScan: { maximumAccountBytes: 10_485_760, outputCountAtWidthOne: 9_320_305, eightCellWindowsAtWidthOne: Math.ceil(9_320_305 / 8), exampleOutputs: 10_240, exampleWidthBytes: 16, exampleRecordBytes: 424 + 10_240 * 16 + Math.ceil(10_240 / 8), wholeResultProjectionFitsOneFact: false, wholeNonFinalScanFitsOneTransaction: false, needsProtocolProgressRecordOrSupportedLimit: true },
      revision9TerminalPayoutMarkerClosesDpa1: false,
      dpa1ClosureIsSeparateTag172PlanDecision: true,
    },
    executionScope: { identitySizingExecutesDecision: false, foldScenariosExecuted: handlers.map(h => ({ tag: h.tag, cases: h.executedFoldCases })), decisionSemanticsExecuted: false, handlersImplementedOrDeployed: false, CUClaim: false },
    sbfErrors, handlers,
  };
  const text = JSON.stringify(result, null, 2) + '\n';
  if (nativeOnly) {
    atomicallyWrite(path.join(outDir, 'native-only-provisional.json'), text);
    console.log(`Native codec and Bend fold gates passed; provisional receipt ${path.relative(root, path.join(outDir, 'native-only-provisional.json'))}`);
    return;
  }
  if (!sbfComplete) {
    const first = sbfErrors[0] ?? { code: 'DCG-SBF-BUILD-ERROR', message: 'SBF frames did not complete' };
    const failure = { status: 'failed', diagnosticCode: first.code, reason: first.message,
      missingSbfFramesForTags: handlers.filter(h => h.compiledFrame.status !== 'measured').map(h => h.tag),
      provisionalNativeAndFoldGatesPassed: true, successReportPublished: false, attemptedReport: result,
      artifactRoot: path.relative(root, outDir), artifactOutputSha256: currentArtifactOutputs() };
    atomicallyWrite(path.join(outDir, 'acceptance-failed.json'), JSON.stringify(failure, null, 2) + '\n');
    fail(first.code, `Required SBF frame acceptance failed for tags ${failure.missingSbfFramesForTags.join(', ')}: ${first.message}`);
  }
  atomicallyWrite(path.join(outDir, 'report.json'), text);
  atomicallyPublishCanonical(path.join(canonicalDir, 'report.json'), text);
  canonicalReportPublishedForRun = true;
  if (recordReport) atomicallyWrite('tests/dcg-facts/sizing-report.json', text);
  console.log(`DCG revision-9 fact sizing acceptance passed for ${handlers.length} identity envelopes and Bend folds; canonical report ${path.relative(root, path.join(canonicalDir, 'report.json'))}`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    const diagnostic = receiptError(error);
    const message = diagnostic.message;
    const failureReceipt = path.join(outDir, 'acceptance-failed.json');
    try {
      if (!fs.existsSync(failureReceipt)) {
        const artifactOutputSha256 = currentArtifactOutputs();
        atomicallyWrite(failureReceipt, JSON.stringify({
          status: 'failed',
          diagnosticCode: diagnostic.code,
          reason: 'acceptance aborted before a complete success report was published',
          error: message,
          diagnosticDetails: diagnostic.details,
          runId, artifactRoot: path.relative(root, outDir), artifactOutputSha256,
          successReportPublished: canonicalReportPublishedForRun,
        }, null, 2) + '\n');
      }
    } catch (receiptError) {
      console.error(`Could not write failure receipt: ${receiptError instanceof Error ? receiptError.message : receiptError}`);
    }
    console.error(`[${diagnostic.code}] ${message}`);
    process.exitCode = 1;
  }
}
