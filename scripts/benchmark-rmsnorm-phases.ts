// Diagnostic copies of the checked artifacts and independent Rust baseline.
// Production sources and ELFs are never instrumented in place.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, sbfTools } from './build.ts';

const dir = 'build/rmsnorm-phases';
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const production = ['build/rmsnorm-bend.so', 'build/rmsnorm-rust.so',
  'build/rmsnorm-benchmark.json', 'build/rmsnorm-vectors.json'];
const before = Object.fromEntries(production.map(file => {
  assert(fs.existsSync(file), `run npm run benchmark:rmsnorm first: ${file}`);
  return [file, hash(file)];
}));
const baseline = JSON.parse(fs.readFileSync('build/rmsnorm-benchmark.json', 'utf8')) as {
  bendElfHash:string; rustElfHash:string; bendHeaderHash:string;
  bendWireHash:string; bendDispatchHash:string; bendEntryHash:string;
  sourceHashes:Record<string,string>;
};
assert.equal(hash('build/rmsnorm-bend.so'), baseline.bendElfHash, 'stale Bend ELF');
assert.equal(hash('build/rmsnorm-rust.so'), baseline.rustElfHash, 'stale Rust ELF');
for (const [file,digest] of [
  ['build/rmsnorm-bend.h',baseline.bendHeaderHash],
  ['build/rmsnorm-bend.wire.h',baseline.bendWireHash],
  ['build/rmsnorm-bend.dispatch.h',baseline.bendDispatchHash],
  ['build/rmsnorm-bend-entry.c',baseline.bendEntryHash],
]) assert.equal(hash(file),digest,`stale generated RMSNorm artifact: ${file}`);
for (const [file,digest] of Object.entries(baseline.sourceHashes))
  assert.equal(hash(file), digest, `stale RMSNorm source: ${file}; rerun benchmark:rmsnorm`);
function replace(source: string, oldText: string, newText: string): string {
  assert.equal(source.split(oldText).length, 2, `expected one diagnostic substitution: ${oldText}`);
  return source.replace(oldText, newText);
}
function checkImports(file: string, allowed: Set<string>) {
  const symbols = run(path.join(sbfTools(), 'llvm-readelf'), ['-s', file], true);
  for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    const symbol = line.trim().split(/\s+/).at(-1)!;
    assert(symbol === 'UND' || allowed.has(symbol), `unexpected SBF import: ${symbol}`);
  }
  assert.match(symbols, /\bsol_log_compute_units_\b/);
  assert.match(run(path.join(sbfTools(), 'llvm-readelf'), ['-h', file], true), /Flags:\s+0x0\b/);
}
const allowed = new Set(['sol_set_return_data', 'sol_memcpy_', 'sol_memmove_',
  'sol_memset_', 'sol_memcmp_', 'sol_log_compute_units_']);
fs.mkdirSync(dir, {recursive:true});
for (const suffix of ['.wire.h', '.dispatch.h']) {
  fs.copyFileSync(`build/rmsnorm-bend${suffix}`, `${dir}/rmsnorm-bend${suffix}`);
}
let header = fs.readFileSync('build/rmsnorm-bend.h', 'utf8');
header = replace(header,
  '      bend__2e__2e__2f_sdk_2f_math_2e_U64_t v12 =',
  '      sol_log_compute_units_(); /* mean */\n      bend__2e__2e__2f_sdk_2f_math_2e_U64_t v12 =');
header = replace(header,
  '      return bend_Reply_make(0u, bend_norm_5f_fold(a1, a2, v12, a4));',
  '      sol_log_compute_units_(); /* sqrt */\n      bend__2e__2e__2f_sdk_2f_math_2e_U64_t value = bend_norm_5f_fold(a1, a2, v12, a4);\n      sol_log_compute_units_(); /* normalized */\n      return bend_Reply_make(0u, value);');
header = replace(header,
  '  return bend_finish_5f_sum(bend_sum_5f_fold(a1, bend_fuel_5f_count(a0, 0u)), a2, a0, a1);',
  '  sol_log_compute_units_(); /* decoded */\n  bend_SumResult_t sum = bend_sum_5f_fold(a1, bend_fuel_5f_count(a0, 0u));\n  sol_log_compute_units_(); /* sum */\n  return bend_finish_5f_sum(sum, a2, a0, a1);');
fs.writeFileSync(`${dir}/rmsnorm-bend.h`, header);
let entry = fs.readFileSync('build/rmsnorm-bend-entry.c', 'utf8');
entry = replace(entry, '#include "rmsnorm-bend.dispatch.h"',
  'extern void sol_log_compute_units_(void);\n#include "rmsnorm-bend.dispatch.h"');
entry = replace(entry, '  u8 output[14]; u64 written=0;',
  '  sol_log_compute_units_(); /* baseline */\n  u8 output[14]; u64 written=0;');
entry = replace(entry, '  sol_set_return_data(output,written); return 0;',
  '  sol_log_compute_units_(); /* encoded */\n  sol_set_return_data(output,written); return 0;');
fs.writeFileSync(`${dir}/entry.c`, entry);
const tools = sbfTools();
const clang = path.join(tools, 'clang');
assert(run(clang, ['--version'], true).includes('20.1.7'));
const flags = ['--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding',
  '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
  '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections',
  '-fdata-sections', `-I${dir}`, '-Ibuild', '-Iruntime'];
run(clang, [...flags, '-c', `${dir}/entry.c`, '-o', `${dir}/bend.o`]);
run(clang, [...flags, '-c', 'runtime/memory.c', '-o', `${dir}/memory.o`]);
const frames = fs.readFileSync(`${dir}/bend.su`, 'utf8').trim().split('\n').map(line => Number(line.split('\t')[1]));
assert(frames.every(Number.isFinite) && Math.max(...frames) <= 4096, 'diagnostic stack exceeds SBF limit');
run(path.join(tools, 'ld.lld'), ['-z', 'notext', '-shared', '--Bdynamic',
  'runtime/sbf.ld', '--entry', 'entrypoint', '-z', 'max-page-size=4096',
  '--gc-sections', `${dir}/bend.o`, `${dir}/memory.o`, '-o', `${dir}/bend.so`]);
checkImports(`${dir}/bend.so`, allowed);

let rust = fs.readFileSync('benchmarks/rmsnorm-rust/main.rs', 'utf8');
rust = replace(rust, '    fn sol_set_return_data(data: *const u8, length: u64);',
  '    fn sol_set_return_data(data: *const u8, length: u64);\n    fn sol_log_compute_units_();');
rust = replace(rust, '    let sum = samples[..n].iter()',
  '    unsafe { sol_log_compute_units_(); } // decoded\n    let sum = samples[..n].iter()');
rust = replace(rust, '    let mean = sum / n as u64;',
  '    unsafe { sol_log_compute_units_(); } // sum\n    let mean = sum / n as u64;');
rust = replace(rust, '    let root = isqrt(',
  '    unsafe { sol_log_compute_units_(); } // mean\n    let root = isqrt(');
rust = replace(rust, '    let mut checksum = 0i64;',
  '    unsafe { sol_log_compute_units_(); } // sqrt\n    let mut checksum = 0i64;');
rust = replace(rust, '    (0, checksum)',
  '    unsafe { sol_log_compute_units_(); } // normalized\n    (0, checksum)');
rust = replace(rust, '    let header = core::slice::from_raw_parts(input, 16);',
  '    sol_log_compute_units_(); // baseline\n    let header = core::slice::from_raw_parts(input, 16);');
rust = replace(rust, '    sol_set_return_data(reply.as_ptr(), reply.len() as u64);',
  '    sol_log_compute_units_(); // encoded\n    sol_set_return_data(reply.as_ptr(), reply.len() as u64);');
fs.writeFileSync(`${dir}/rust.rs`, rust);
const rustc = path.resolve(tools, '../../rust/bin/rustc');
run(rustc, ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort',
  `${dir}/rust.rs`, '-o', `${dir}/rust.so`]);
checkImports(`${dir}/rust.so`, allowed);

for (const implementation of ['bend', 'rust']) {
  const report = `${dir}/${implementation}-raw.json`;
  const env = {...process.env, RMSNORM_ELF:path.resolve(`${dir}/${implementation}.so`),
    RMSNORM_METRICS:path.resolve(report), CARGO_TARGET_DIR:path.resolve('target/rmsnorm')};
  for (let i=0; i<2; i++) {
    const result = spawnSync('cargo', ['test', '--locked', '--test', 'rmsnorm_phases', '--', '--nocapture'],
      {stdio:'inherit',env});
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${implementation} diagnostic failed`);
    if (i===0) fs.copyFileSync(report, `${report}.first`);
    else assert.equal(fs.readFileSync(report, 'utf8'), fs.readFileSync(`${report}.first`, 'utf8'),
      `${implementation} phases did not repeat`);
  }
}
for (const [file,digest] of Object.entries(before)) assert.equal(hash(file), digest,
  `diagnostic changed production artifact: ${file}`);
const bend = JSON.parse(fs.readFileSync(`${dir}/bend-raw.json`, 'utf8'));
const rustRows = JSON.parse(fs.readFileSync(`${dir}/rust-raw.json`, 'utf8'));
assert.deepEqual(bend.map((row: {name:string}) => row.name), rustRows.map((row: {name:string}) => row.name));
fs.writeFileSync(`${dir}/report.json`, JSON.stringify({
  diagnosticOnly:true, productionHashes:before, bendElfHash:hash(`${dir}/bend.so`),
  rustElfHash:hash(`${dir}/rust.so`), repeatedIdentically:true,
  rows:bend.map((row: {name:string; total:number; intervals:number[]}, i:number) => ({
    name:row.name, bend:row, rust:rustRows[i]}))}, null, 2)+'\n');
console.log(`RMSNorm phase diagnostic passed twice: ${dir}/report.json`);
