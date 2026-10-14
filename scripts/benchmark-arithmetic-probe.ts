import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook, mangle } from '../compiler/backend.ts';
import { BEND_COMMIT, compileSbf, prepareBend, run, sbfTools } from './build.ts';

const buildDir = 'build';
fs.mkdirSync(buildDir, { recursive: true });
for (const file of ['arithmetic-probe-benchmark.json', 'arithmetic-probe-bend-raw.json',
  'arithmetic-probe-rust-raw.json']) fs.rmSync(path.join(buildDir, file), { force: true });

prepareBend();
const book = await checkedBook('tests/arithmetic.bend');
const operations = ['add64', 'less64', 'mul64', 'div64', 'mod64', 'sub64'] as const;
const emitted = new Backend(book).emit([...operations]);
const dispatchArms = operations.map((name, opcode) => opcode === 1
  ? `case ${opcode}: *lo = ${mangle(name)}(al, ah, bl, bh); return;`
  : `case ${opcode}: { bend_Reply_t result = ${mangle(name)}(al, ah, bl, bh);
      *error = result.as.c0.f0; *lo = result.as.c0.f1; *hi = result.as.c0.f2; return; }`);
fs.writeFileSync(`${buildDir}/arithmetic-probe-bend.h`, emitted.c);
fs.writeFileSync(`${buildDir}/arithmetic-probe-dispatch.h`, `#include "arithmetic-probe-bend.h"
static void dispatch(unsigned op, unsigned al, unsigned ah, unsigned bl, unsigned bh,
    unsigned *error, unsigned *lo, unsigned *hi) {
  *error = 0; *lo = 0; *hi = 0;
  switch (op) { ${dispatchArms.join('\n')} }
  *error = 9;
}\n`);
fs.writeFileSync(`${buildDir}/arithmetic-probe-bend.c`, `#include "solana_min.h"
#include "arithmetic-probe-dispatch.h"
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 0 || read_le(input + 8, 8) != 17) return 1;
  const u8 *p = input + 16;
  unsigned error, lo, hi;
  dispatch(p[0], (u32)read_le(p + 1, 4), (u32)read_le(p + 5, 4),
    (u32)read_le(p + 9, 4), (u32)read_le(p + 13, 4), &error, &lo, &hi);
  u8 output[12];
  write_le(output, error, 4); write_le(output + 4, lo, 4); write_le(output + 8, hi, 4);
  sol_set_return_data(output, 12);
  return 0;
}\n`);
const bendFirst = compileSbf(`${buildDir}/arithmetic-probe-bend.c`, `${buildDir}/arithmetic-probe-bend`);
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bendElfHash = hash(`${buildDir}/arithmetic-probe-bend.so`);
compileSbf(`${buildDir}/arithmetic-probe-bend.c`, `${buildDir}/arithmetic-probe-bend`);
assert.equal(hash(`${buildDir}/arithmetic-probe-bend.so`), bendElfHash,
  'Bend probe rebuild must be byte-identical');

const tools = sbfTools();
const rustc = path.resolve(tools, '../../rust/bin/rustc');
const rustVersion = run(rustc, ['--version', '--verbose'], true);
assert(rustVersion.includes('1.89.0-dev') && rustVersion.includes('LLVM version: 20.1.7'),
  'Expected the Rust compiler shipped with Anza platform-tools v1.53');
const rustSource = 'benchmarks/arithmetic-probe-rust/main.rs';
const rustElf = `${buildDir}/arithmetic-probe-rust.so`;
const rustFlags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort'];
run(rustc, [...rustFlags, rustSource, '-o', rustElf]);
const rustElfHash = hash(rustElf);
run(rustc, [...rustFlags, rustSource, '-o', rustElf]);
assert.equal(hash(rustElf), rustElfHash, 'Rust probe rebuild must be byte-identical');
const readelf = path.join(tools, 'llvm-readelf');
assert.match(run(readelf, ['-h', rustElf], true), /Flags:\s+0x0\b/, 'Expected SBF v0 Rust ELF');
const allowedImports = new Set(['abort', 'sol_set_return_data', 'sol_memcpy_', 'sol_memset_']);
for (const line of run(readelf, ['-s', rustElf], true).split('\n').filter(line => /\bUND\b/.test(line))) {
  const symbol = line.trim().split(/\s+/).at(-1)!;
  assert(symbol === 'UND' || allowedImports.has(symbol), `Unexpected Rust SBF import: ${symbol}`);
}

const max = (1n << 64n) - 1n;
const split = (n: bigint) => [Number(n & 0xffffffffn), Number(n >> 32n)];
const makeCase = (name: string, opcode: number, a: bigint, b: bigint) => {
  let expected: number[];
  if (opcode === 0) expected = a + b > max ? [1, 0, 0] : [0, ...split(a + b)];
  else if (opcode === 1) expected = [0, Number(a < b), 0];
  else if (opcode === 2) expected = a * b > max ? [1, 0, 0] : [0, ...split(a * b)];
  else if (opcode === 3) expected = b === 0n ? [3, 0, 0] : [0, ...split(a / b)];
  else if (opcode === 4) expected = b === 0n ? [3, 0, 0] : [0, ...split(a % b)];
  else expected = a < b ? [2, 0, 0] : [0, ...split(a - b)];
  const input = Buffer.alloc(17);
  input[0] = opcode;
  for (const [index, value] of [...split(a), ...split(b)].entries()) {
    input.writeUInt32LE(value, 1 + index * 4);
  }
  const reply = Buffer.alloc(12);
  expected.forEach((value, index) => reply.writeUInt32LE(value, index * 4));
  return { name, input: [...input], expected: [...reply] };
};
const fixtures = [
  makeCase('add_no_overflow', 0, 0x00000001fffffff0n, 0x0000000200000030n),
  makeCase('compare_high_limb', 1, 0xfedcba9876543210n, 0xfedcba997654320fn),
  makeCase('mul_wide_intermediate', 2, (1n << 32n) + 3n, (1n << 16n) + 5n),
  makeCase('mul_overflow', 2, max, 2n),
  makeCase('div_wide_operands', 3, 0xfedcba9876543210n, 0x102030405n),
  makeCase('div_small_operands', 3, 400_000n, 300n),
  makeCase('div_by_one', 3, 0xfedcba9876543210n, 1n),
  makeCase('div_large_divisor', 3, 400_000n, 0x102030405n),
  makeCase('div_by_zero', 3, 0xfedcba9876543210n, 0n),
  makeCase('mod_wide_operands', 4, 0xfedcba9876543210n, 0x102030405n),
  makeCase('mod_small_operands', 4, 400_000n, 300n),
  makeCase('mod_by_one', 4, 0xfedcba9876543210n, 1n),
  makeCase('sub_no_underflow', 5, 0xfedcba9876543210n, 0x123456789abcdefn),
  makeCase('sub_underflow', 5, 0n, 1n),
];
fs.writeFileSync(`${buildDir}/arithmetic-probe-vectors.json`, JSON.stringify(fixtures, null, 2) + '\n');

const runFixtureTest = (elf: string, metrics: string) => {
  const result = spawnSync('cargo', ['test', '--locked', '--test', 'arithmetic_probe_benchmark',
    '--', '--nocapture'], { stdio: 'inherit', env: { ...process.env,
      CARGO_TARGET_DIR: path.resolve('target/arithmetic-probe'),
      ARITHMETIC_PROBE_ELF: elf, ARITHMETIC_PROBE_METRICS: metrics } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Arithmetic probe fixtures failed for ${elf}`);
};
const measures = new Map<string, any[]>();
const programs: [string, string][] = [['bend', `${buildDir}/arithmetic-probe-bend.so`], ['rust', rustElf]];
for (const program of programs) {
  const kind = program[0];
  const elf = program[1];
  const metrics = `${buildDir}/arithmetic-probe-${kind}-raw.json`;
  runFixtureTest(elf, metrics);
  const first = fs.readFileSync(metrics, 'utf8');
  runFixtureTest(elf, metrics);
  assert.equal(fs.readFileSync(metrics, 'utf8'), first,
    `${kind} fixed-fixture CU results must reproduce exactly`);
  measures.set(kind, JSON.parse(first));
}

const bendRows = measures.get('bend')!;
const rustRows = measures.get('rust')!;
assert.equal(bendRows.length, fixtures.length);
assert.equal(rustRows.length, fixtures.length);
const rows = bendRows.map((bend, index) => {
  const rust = rustRows[index];
  const { computeUnits: bendCU, ...bendFixture } = bend;
  const { computeUnits: rustCU, ...rustFixture } = rust;
  assert.deepEqual(bendFixture, rustFixture, `Matched input/output/outcome differs for ${bend.name}`);
  return { name: bend.name, outerSuccess: bend.outerSuccess, bendCU, rustCU,
    ratio: bendCU / rustCU,
    fixtureSha256: crypto.createHash('sha256').update(JSON.stringify(bendFixture)).digest('hex') };
});

const inputs = [rustSource, 'scripts/benchmark-arithmetic-probe.ts', 'tests/arithmetic_probe_benchmark.rs',
  'tests/arithmetic.bend', 'sdk/math.bend', 'sdk/PROOF.bend', 'compiler/backend.ts', 'compiler/tagged-sum-ir.ts',
  'compiler/native-arithmetic.ts',
  'compiler/primitives.ts', 'runtime/solana_min.h', 'runtime/memory.c', 'runtime/sbf.ld',
  'Cargo.toml', 'Cargo.lock'];
const hashes = Object.fromEntries(inputs.map(file => [file, hash(file)]));
const bendBuild = { clangVersion: bendFirst.version, target: 'SBF v0 / generic', cpu: 'generic',
  optimization: '-O2', emittedFunctions: emitted.functions, elfBytes: fs.statSync(`${buildDir}/arithmetic-probe-bend.so`).size,
  elfSha256: bendElfHash, sourceSha256: hash('tests/arithmetic.bend'), compilerSourceSha256: hash('compiler/backend.ts'),
  compilerModuleSha256: Object.fromEntries(fs.readdirSync('compiler').filter(f => f.endsWith('.ts'))
    .map(f => [`compiler/${f}`, hash(`compiler/${f}`)])),
  reproducible: true };
const rustBuild = { rustVersion, flags: rustFlags, target: 'SBF v0 / generic',
  elfBytes: fs.statSync(rustElf).size, elfSha256: rustElfHash, sourceSha256: hash(rustSource), reproducible: true };
fs.writeFileSync(`${buildDir}/arithmetic-probe-bend.manifest.json`, JSON.stringify(bendBuild, null, 2) + '\n');
fs.writeFileSync(`${buildDir}/arithmetic-probe-rust.manifest.json`, JSON.stringify(rustBuild, null, 2) + '\n');
const report = { runtime: 'LiteSVM 0.7.1', target: 'SBPFv0 / generic',
  bendDependencyCommit: BEND_COMMIT, fixtureContract: '17 instruction bytes -> 12 return-data bytes; no accounts or CPIs',
  semantics: 'Checked overflow, underflow and divide-by-zero are encoded as error codes 1, 2 and 3 in return data; all fixtures have successful Solana invocations.',
  scope: 'Instruction plus selected arithmetic, return-data handling, and LiteSVM transaction overhead; excludes application decoding, account validation, storage, and CPI costs.',
  semanticMatchPassed: true, outerSuccessForAllFixtures: true,
  repeatedIdentically: true, fixtures: rows, hostRust: run('rustc', ['--version'], true),
  bun: process.versions.bun, bendBuild, rustBuild, hashes };
fs.writeFileSync(`${buildDir}/arithmetic-probe-benchmark.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Arithmetic probe: ${rows.length} matched fixtures; semantic conformance, repeatability and hashes verified`);
