// SBPFv3 application acceptance: builds the six applications (and the vault's
// settlement fixture) as solana-v3 programs into a fresh run directory, checks
// each with the v3 final-image gate, then runs the shared Rust application tests
// (tests/*_sbf.rs) on LiteSVM 0.13.0 via tests-modern/. v0 outputs in build/
// are only read, never written.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProgram } from '../scripts/program.ts';
import { compileSbfV3 } from '../scripts/build-v3.ts';
import { acceptSbpfV3FinalImage, checkSbpfV3FinalImage } from '../compiler/sbpf-v3-final-image.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { testSbpfV3FinalImage } from './sbpf-v3-final-image.ts';

const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
const runDir = path.resolve(`build/sbpf-v3/${runId}`);
const stage = path.join(runDir, 'stage/build');
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = (file: string) => ({ bytes: fs.statSync(file).size, sha256: hash(file) });

const APPLICATIONS = [
  { name: 'vault', source: 'examples/vault/PROOF.bend', root: 'vault.process' },
  { name: 'vesting', source: 'examples/vesting/PROOF.bend', root: 'vesting.process' },
  { name: 'exchange', source: 'examples/exchange/PROOF.bend', root: 'exchange.process' },
  { name: 'amm', source: 'examples/amm/PROOF.bend', root: 'amm.process' },
  { name: 'batch', source: 'examples/batch/PROOF.bend', root: 'batch.process' },
  { name: 'queue', source: 'examples/queue/PROOF.bend', root: 'queue.process', layout: 'examples/queue/storage.json' },
];
// Target-independent inputs produced by the TypeScript application tests.
const COPIED_INPUTS = ['amm-client-vectors.json'];
const TEST_FILTERS = APPLICATIONS.map(app => `${app.name}_sbf::`);

fs.mkdirSync(stage, { recursive: true });
console.log(`SBPFv3 application run ${path.relative(process.cwd(), runDir)}`);

const builds: Record<string, unknown> = {};
for (const app of APPLICATIONS) {
  const manifest = await buildProgram(app.source, app.root, path.join(stage, app.name), app.layout, 'solana-v3');
  builds[app.name] = { manifest: path.relative(process.cwd(), path.join(stage, `${app.name}.manifest.json`)),
    elf: record(path.join(stage, `${app.name}.so`)), maxActiveFrames: manifest.sbpfV3FinalImage.maxActiveFrames,
    syscalls: manifest.sbpfV3FinalImage.syscalls };
}
// The vault tests' two-leg settlement probe, emitted and compiled like tests/vault.ts.
const settlementStem = path.join(stage, 'settlement');
writeArtifacts(settlementStem, new Backend(await checkedBook('tests/settlement.bend')).emit(['process']), 'process');
compileSbfV3(`${settlementStem}.c`, settlementStem);
const settlementGate = acceptSbpfV3FinalImage(`${settlementStem}.so`, path.join(stage, 'sbpf-v3-final-image/settlement.json'));
builds.settlement = { elf: record(`${settlementStem}.so`), maxActiveFrames: settlementGate.maxActiveFrames };

for (const file of COPIED_INPUTS) {
  assert(fs.existsSync(`build/${file}`), `Missing build/${file}; run npm test first`);
  fs.copyFileSync(`build/${file}`, path.join(stage, file));
}
for (const name of [...APPLICATIONS.map(app => app.name), 'settlement']) {
  const report = checkSbpfV3FinalImage(fs.readFileSync(path.join(stage, `${name}.so`)));
  assert.equal(report.status, 'accepted', `${name}.so must be an accepted SBPFv3 image`);
}

await testSbpfV3FinalImage(path.join(stage, 'vault.so'));

// tests-modern resolves "build/..." inside its package directory.
const link = path.resolve('tests-modern/build');
function runTests(label: string, stageDir: string) {
  if (fs.lstatSync(link, { throwIfNoEntry: false })) {
    assert(fs.lstatSync(link).isSymbolicLink(), 'tests-modern/build must be a symlink managed by this driver');
    fs.unlinkSync(link);
  }
  fs.symlinkSync(stageDir, link);
  const cargo = spawnSync('cargo', ['test', '--locked', '--offline', '--target-dir', '../target/tests-modern',
    '--test', 'sbf', '--', ...TEST_FILTERS, '--nocapture'],
  { cwd: path.resolve('tests-modern'), encoding: 'utf8', env: { ...process.env, BATCH_METRICS: path.join(stageDir, 'batch-metrics.json') } });
  const output = `${cargo.stdout}${cargo.stderr}`;
  const log = path.join(runDir, `cargo-test-${label}.log`);
  fs.writeFileSync(log, output);
  const summary = output.match(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
  assert.equal(cargo.status, 0, `${label} application tests failed; see ${log}\n${output.slice(-4000)}`);
  assert(summary && summary[1] === 'ok' && Number(summary[2]) > 0, 'Cargo did not report passing tests');
  const names = [...output.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(match => match[1]);
  for (const app of APPLICATIONS) {
    assert(names.some(name => name.startsWith(`${app.name}_sbf::`)), `No passing ${app.name} tests ran (${label})`);
  }
  const metrics = Object.fromEntries(['vault', 'vesting', 'exchange', 'batch'].map(name => {
    const file = path.join(stageDir, `${name}-metrics.json`);
    return [name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
  }));
  return { passed: Number(summary![2]), failed: Number(summary![3]), ignored: Number(summary![4]), names,
    log: path.relative(process.cwd(), log), metrics };
}
const v3Tests = runTests('sbpf-v3', stage);

// Same tests and runtime on the existing SBPFv0 ELFs (copied; build/ is not written).
const v0Stage = path.join(runDir, 'stage-v0/build');
fs.mkdirSync(v0Stage, { recursive: true });
const v0Elves: Record<string, unknown> = {};
for (const name of [...APPLICATIONS.map(app => app.name), 'settlement']) {
  for (const suffix of ['.so', '.interface.json']) {
    assert(fs.existsSync(`build/${name}${suffix}`), `Missing build/${name}${suffix}; run npm test first`);
    fs.copyFileSync(`build/${name}${suffix}`, path.join(v0Stage, `${name}${suffix}`));
  }
  const bytes = fs.readFileSync(path.join(v0Stage, `${name}.so`));
  assert.equal(bytes.readUInt32LE(48), 0, `build/${name}.so must be SBPFv0`);
  v0Elves[name] = record(path.join(v0Stage, `${name}.so`));
}
for (const file of COPIED_INPUTS) fs.copyFileSync(`build/${file}`, path.join(v0Stage, file));
const v0Tests = runTests('sbpf-v0', v0Stage);
const comparable = Object.fromEntries(['vault', 'vesting', 'exchange'].map(name => [name, {
  v0: v0Tests.metrics[name], v3: v3Tests.metrics[name] }]));
const receipt = {
  version: 1, kind: 'bend-sbpf-v3-application-acceptance', runId,
  scope: 'Rust application tests on LiteSVM 0.13.0 all-enabled features; SBPFv3 ELFs built by buildProgram --target solana-v3',
  sources: Object.fromEntries(['scripts/program.ts', 'scripts/build-v3.ts', 'compiler/sbpf-v3-final-image.ts',
    'compiler/target-profile.ts', 'runtime/sbpfv3_syscalls.c', 'runtime/sbpfv3.ld', 'runtime/memory.c',
    'tests/sbpf-v3-programs.ts', 'tests/sbf.rs', 'tests-modern/Cargo.toml', 'tests-modern/Cargo.lock',
    ...APPLICATIONS.map(app => `tests/${app.name}_sbf.rs`)].map(file => [file, hash(file)])),
  builds,
  v0Elves,
  tests: { filters: TEST_FILTERS, sbpfV3: v3Tests, sbpfV0SameRuntime: v0Tests },
  sameRuntimeComparison: comparable,
};
fs.writeFileSync(path.join(runDir, 'acceptance.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`${v3Tests.passed} SBPFv3 and ${v0Tests.passed} SBPFv0 application tests passed on LiteSVM 0.13.0 (${v3Tests.ignored} ignored); ` +
  `receipt ${path.relative(process.cwd(), path.join(runDir, 'acceptance.json'))}`);
