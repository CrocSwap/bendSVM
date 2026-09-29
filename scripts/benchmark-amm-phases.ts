// Diagnostic copies only. The checked Bend build and the independent Rust
// baseline are instrumented after their normal source build, never in place.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, sbfTools } from './build.ts';
import { buildProgram } from './program.ts';

const directory = 'build/amm-phases';
const checked = `${directory}/checked`;
const bend = `${directory}/bend`;
const rust = `${directory}/rust`;
const report = `${directory}/report.json`;
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const production = ['build/amm.so', 'build/amm-rust.so', 'build/amm-benchmark.json'];
const before = Object.fromEntries(production.filter(fs.existsSync).map(file => [file, hash(file)]));

function substitute(source: string, oldText: string, newText: string): string {
  assert.equal(source.split(oldText).length, 2, `expected one exact diagnostic substitution: ${oldText}`);
  return source.replace(oldText, newText);
}

function checkImports(elf: string, allowed: Set<string>) {
  const symbols = run(path.join(sbfTools(), 'llvm-readelf'), ['-s', elf], true);
  for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    const symbol = line.trim().split(/\s+/).at(-1)!;
    assert(symbol === 'UND' || allowed.has(symbol), `unexpected diagnostic SBF import: ${symbol}`);
  }
  assert.match(symbols, /\bsol_log_compute_units_\b/, 'missing diagnostic CU syscall import');
  assert.match(run(path.join(sbfTools(), 'llvm-readelf'), ['-h', elf], true),
    /Flags:\s+0x0\b/, 'expected SBF v0 ELF');
}

function compileDiagnosticBend(source: string, stem: string) {
  const tools = sbfTools();
  const clang = path.join(tools, 'clang');
  const version = run(clang, ['--version'], true);
  assert(version.includes('20.1.7') && version.includes('anza-xyz'),
    'expected Anza platform-tools v1.53 Clang');
  // Same target, optimization, warnings and linker invocation as compileSbf;
  // the diagnostic-only import check below admits the logging syscall.
  const flags = ['--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding',
    '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections',
    '-fdata-sections', '-Ibuild', '-Iruntime'];
  run(clang, [...flags, '-c', source, '-o', `${stem}.o`]);
  run(clang, [...flags, '-c', 'runtime/memory.c', '-o', `${stem}.memory.o`]);
  run(path.join(tools, 'ld.lld'), ['-z', 'notext', '-shared', '--Bdynamic',
    'runtime/sbf.ld', '--entry', 'entrypoint', '-z', 'max-page-size=4096',
    '--gc-sections', `${stem}.o`, `${stem}.memory.o`, '-o', `${stem}.so`]);
  const frames = fs.readFileSync(`${stem}.su`, 'utf8').trim().split('\n').map(line => {
    const bytes = Number(line.split('\t')[1]);
    assert(Number.isFinite(bytes), `invalid diagnostic stack report: ${line}`);
    return bytes;
  });
  assert(Math.max(...frames) <= 4096, 'diagnostic Bend frame exceeds SBF stack limit');
}

async function main() {
  fs.mkdirSync(directory, { recursive: true });
  fs.rmSync(report, { force: true });
  await buildProgram('examples/amm/PROOF.bend', 'amm.process', checked);

  let source = fs.readFileSync(`${checked}.c`, 'utf8');
  source = substitute(source, 'extern u64 sol_get_clock_sysvar(void *);',
    'extern u64 sol_get_clock_sysvar(void *);\nextern void sol_log_compute_units_(void);');
  source = substitute(source, 'u64 entrypoint(const u8 *input) {',
    'u64 entrypoint(const u8 *input) {\n  sol_log_compute_units_(); /* baseline */');
  source = substitute(source, '  u8 bump; u64 setup = bend_custody(accounts,program,&bump);',
    '  sol_log_compute_units_(); /* accounts_parsed */\n  u8 bump; u64 setup = bend_custody(accounts,program,&bump);');
  source = substitute(source, '  if (state.size != 216) return 4;',
    '  if (state.size != 216) return 4;\n  sol_log_compute_units_(); /* parsed_pda */');
  source = substitute(source, '  bend_amm_2e_Outcome_t outcome = bend_amm_2e_process(context, before, instruction);',
    '  sol_log_compute_units_(); /* decoded_clock */\n  bend_amm_2e_Outcome_t outcome = bend_amm_2e_process(context, before, instruction);\n  sol_log_compute_units_(); /* transition */');
  source = substitute(source, '  BendTransfer transfers[3];',
    '  sol_log_compute_units_(); /* state_encoded */\n  BendTransfer transfers[3];');
  source = substitute(source, '  for (unsigned i = 0; i < 3; ++i) {\n    u64 error = bend_transfer_validate',
    '  sol_log_compute_units_(); /* effects_extracted */\n  for (unsigned i = 0; i < 3; ++i) {\n    u64 error = bend_transfer_validate');
  source = substitute(source, '  for (unsigned i = 0; i < 3; ++i) {\n    if (bend_transfer_execute',
    '  sol_log_compute_units_(); /* validated */\n  for (unsigned i = 0; i < 3; ++i) {\n    if (bend_transfer_execute');
  source = substitute(source, '  for (unsigned i = 0; i < 20; ++i) state.data[i] = header[i];',
    '  sol_log_compute_units_(); /* token_executed */\n  for (unsigned i = 0; i < 20; ++i) state.data[i] = header[i];');
  source = substitute(source, '  sol_set_return_data(encoded, 196);',
    '  sol_log_compute_units_(); /* state_written */\n  sol_set_return_data(encoded, 196);');
  fs.writeFileSync(`${bend}.c`, source);
  compileDiagnosticBend(`${bend}.c`, bend);
  checkImports(`${bend}.so`, new Set(['sol_set_return_data', 'sol_get_clock_sysvar',
    'sol_try_find_program_address', 'sol_invoke_signed_c', 'sol_memcpy_',
    'sol_memmove_', 'sol_memset_', 'sol_log_compute_units_']));

  const rustSource = `${directory}/rust-src`;
  fs.mkdirSync(rustSource, { recursive: true });
  for (const name of ['main.rs', 'pricing.rs', 'transition.rs', 'wire.rs']) {
    fs.copyFileSync(`benchmarks/amm-rust/${name}`, `${rustSource}/${name}`);
  }
  let rs = fs.readFileSync(`${rustSource}/main.rs`, 'utf8');
  rs = substitute(rs, '    fn sol_get_clock_sysvar(clock: *mut u8) -> u64;',
    '    fn sol_get_clock_sysvar(clock: *mut u8) -> u64;\n    fn sol_log_compute_units_();');
  rs = substitute(rs, 'unsafe fn run(input: *const u8) -> Result<(), u64> {',
    'unsafe fn run(input: *const u8) -> Result<(), u64> {\n    sol_log_compute_units_(); // baseline');
  rs = substitute(rs, '    if state.data_len != wire::STATE_BYTES as u64 {\n        return Err(4);\n    }',
    '    if state.data_len != wire::STATE_BYTES as u64 {\n        return Err(4);\n    }\n    sol_log_compute_units_(); // parsed_pda');
  rs = substitute(rs, '    if !accounts[2].executable || *accounts[2].key() != TOKEN {',
    '    sol_log_compute_units_(); // accounts_parsed\n    if !accounts[2].executable || *accounts[2].key() != TOKEN {');
  rs = substitute(rs, '    let (after, effects) = transition::process(accounts[1].signer, before, instruction)\n        .map_err(|code| 256 + u64::from(code))?;',
    '    sol_log_compute_units_(); // decoded_clock\n    let transition = transition::process(accounts[1].signer, before, instruction);\n    sol_log_compute_units_(); // transition\n    let (after, effects) = transition.map_err(|code| 256 + u64::from(code))?;');
  rs = substitute(rs, '    let (after, effects) = transition.map_err(|code| 256 + u64::from(code))?;',
    '    let (after, effects) = transition.map_err(|code| 256 + u64::from(code))?;\n    sol_log_compute_units_(); // effects_ready');
  rs = substitute(rs, '    let encoded = wire::payload(after);',
    '    let encoded = wire::payload(after);\n    sol_log_compute_units_(); // state_encoded');
  rs = substitute(rs, '    for effect in &effects {\n        if execute(effect, accounts, bump) != 0 {',
    '    sol_log_compute_units_(); // validated\n    for effect in &effects {\n        if execute(effect, accounts, bump) != 0 {');
  rs = substitute(rs, '    ptr::copy_nonoverlapping(wire::HEADER.as_ptr(), state.data, 20);',
    '    sol_log_compute_units_(); // token_executed\n    ptr::copy_nonoverlapping(wire::HEADER.as_ptr(), state.data, 20);');
  rs = substitute(rs, '    sol_set_return_data(encoded.as_ptr(), wire::PAYLOAD_BYTES as u64);',
    '    sol_log_compute_units_(); // state_written\n    sol_set_return_data(encoded.as_ptr(), wire::PAYLOAD_BYTES as u64);');
  fs.writeFileSync(`${rustSource}/main.rs`, rs);
  const tools = sbfTools();
  const rustc = path.resolve(tools, '../../rust/bin/rustc');
  const version = run(rustc, ['--version', '--verbose'], true);
  assert(version.includes('1.89.0-dev') && version.includes('LLVM version: 20.1.7'),
    'expected Anza platform-tools v1.53 Rust compiler');
  const flags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
    '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort'];
  run(rustc, [...flags, `${rustSource}/main.rs`, '-o', `${rust}.so`]);
  checkImports(`${rust}.so`, new Set(['abort', 'sol_set_return_data',
    'sol_get_clock_sysvar', 'sol_try_find_program_address', 'sol_invoke_signed_c',
    'sol_memcpy_', 'sol_memmove_', 'sol_memset_', 'sol_memcmp_', 'sol_log_compute_units_']));

  const command = ['test', '--locked', '--test', 'sbf', 'amm_phase_diagnostic_identical_fixtures',
    '--', '--ignored', '--nocapture'];
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = spawnSync('cargo', command, { stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: 'target/amm-phases' } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `AMM phase diagnostic run ${iteration + 1} failed`);
    if (iteration === 0) {
      assert(fs.existsSync(report), 'focused test did not write phase report');
      fs.copyFileSync(report, `${directory}/first-report.json`);
    } else {
      assert.equal(fs.readFileSync(report, 'utf8'),
        fs.readFileSync(`${directory}/first-report.json`, 'utf8'),
        'phase readings must repeat exactly');
    }
  }
  for (const [file, digest] of Object.entries(before)) {
    assert.equal(hash(file), digest, `diagnostic changed production output: ${file}`);
  }
  console.log(`AMM phase diagnostic passed twice; report: ${report}`);
}

await main();
