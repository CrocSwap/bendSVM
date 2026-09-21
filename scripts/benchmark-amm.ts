import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { run } from './build.ts';

fs.mkdirSync('build', { recursive: true });
fs.rmSync('build/amm-benchmark.json', { force: true });
await (await import('../tests/amm.ts')).testAmm();
await import('./build-amm-rust.ts');
for (const elf of ['build/amm.so', 'build/amm-rust.so']) {
  const result = spawnSync('cargo', ['test', '--locked', '--test', 'sbf', 'amm_sbf', '--', '--nocapture'],
    { stdio: 'inherit', env: { ...process.env, AMM_TEST_ELF: elf } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Shared AMM conformance failed for ${elf}`);
}
const command = ['test', '--locked', '--test', 'sbf', 'amm_benchmark_identical_fixtures', '--', '--ignored', '--nocapture'];
run('cargo', command);
const first = fs.readFileSync('build/amm-benchmark.json', 'utf8');
run('cargo', command);
assert.equal(fs.readFileSync('build/amm-benchmark.json', 'utf8'), first,
  'Fixed-fixture benchmark results must reproduce exactly');
const files = ['build/amm.so', 'build/amm-rust.so', 'build/amm.manifest.json',
  'build/amm-rust.manifest.json', 'build/amm.interface.json', 'build/amm.schema.json',
  'tests/amm_sbf.rs', 'tests/token_fixture.rs', 'scripts/benchmark-amm.ts',
  'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json'];
const hashes = Object.fromEntries(files.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report = { ...JSON.parse(first), repeatedIdentically: true, sharedConformancePassed: true,
  hostRust: run('rustc', ['--version'], true), bun: process.versions.bun,
  bendBuild: JSON.parse(fs.readFileSync('build/amm.manifest.json', 'utf8')),
  rustBuild: JSON.parse(fs.readFileSync('build/amm-rust.manifest.json', 'utf8')), hashes };
fs.writeFileSync('build/amm-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log('AMM benchmark: shared conformance, identical fixtures, repeated CU results, and source/toolchain hashes recorded');
