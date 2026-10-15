// Fogo (SBPFv0) on platform-tools v1.57: builds the six applications (and the
// vault's settlement fixture) with buildProgram --target fogo-v0 into a fresh
// run directory, so each passes the ordinary v0 import checks and call-depth
// gate, then runs the shared Rust application tests (tests/*_sbf.rs) on the
// classic LiteSVM 0.7.1 runner against those ELFs. The test binary runs with
// the staged directory as its working directory; build/ is only read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProgram } from '../scripts/program.ts';
import { compileSbf } from '../scripts/build.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { checkLibraryTools, libraryTarget, libraryTools } from '../compiler/target-profile.ts';

const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
const runDir = path.resolve(`build/fogo-v157/${runId}`);
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
console.log(`Fogo v1.57 application run ${path.relative(process.cwd(), runDir)}`);

const builds: Record<string, unknown> = {};
for (const app of APPLICATIONS) {
  const manifest = await buildProgram(app.source, app.root, path.join(stage, app.name), app.layout, 'fogo-v0');
  assert.equal(manifest.platformTools, 'v1.57');
  assert.equal(manifest.targetProfile, 'fogo-v0');
  const bytes = fs.readFileSync(path.join(stage, `${app.name}.so`));
  assert.equal(bytes.readUInt32LE(48), 0, `${app.name}.so must be SBPFv0`);
  const v153 = `build/${app.name}.so`;
  builds[app.name] = { manifest: path.relative(process.cwd(), path.join(stage, `${app.name}.manifest.json`)),
    elf: record(path.join(stage, `${app.name}.so`)), callDepth: manifest.sbfCallDepth.status,
    v153Elf: fs.existsSync(v153) ? record(v153) : null };
}
// The vault tests' two-leg settlement probe, emitted and compiled like tests/vault.ts.
const profile = libraryTarget('fogo-v0');
const tools = libraryTools(profile);
checkLibraryTools(profile, tools, ['clang', 'ld.lld', 'llvm-readelf']);
const settlementStem = path.join(stage, 'settlement');
writeArtifacts(settlementStem, new Backend(await checkedBook('tests/settlement.bend')).emit(['process']), 'process');
compileSbf(`${settlementStem}.c`, settlementStem, { tools, llvm: profile.llvm, platformTools: profile.platformTools });
builds.settlement = { elf: record(`${settlementStem}.so`) };

for (const file of COPIED_INPUTS) {
  assert(fs.existsSync(`build/${file}`), `Missing build/${file}; run npm test first`);
  fs.copyFileSync(`build/${file}`, path.join(stage, file));
}

// Build the classic (LiteSVM 0.7.1) test binary, then run it from the staged directory.
const compiled = spawnSync('cargo', ['test', '--locked', '--offline', '--test', 'sbf', '--no-run', '--message-format=json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
assert.equal(compiled.status, 0, `Classic test binary failed to build\n${compiled.stderr.slice(-4000)}`);
const executable = compiled.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  .find(message => message.reason === 'compiler-artifact' && message.target?.name === 'sbf' && message.executable)?.executable;
assert(executable, 'Cargo did not report the sbf test executable');
const cargo = spawnSync(executable, [...TEST_FILTERS, '--nocapture'],
  { cwd: path.dirname(stage), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, BATCH_METRICS: path.join(stage, 'batch-metrics.json') } });
const output = `${cargo.stdout}${cargo.stderr}`;
const log = path.join(runDir, 'cargo-test-fogo-v157.log');
fs.writeFileSync(log, output);
const summary = output.match(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
assert.equal(cargo.status, 0, `Fogo v1.57 application tests failed; see ${log}\n${output.slice(-4000)}`);
assert(summary && summary[1] === 'ok' && Number(summary[2]) > 0, 'The test binary did not report passing tests');
const names = [...output.matchAll(/^test (\S+) \.\.\. ok$/gm)].map(match => match[1]);
for (const app of APPLICATIONS) {
  assert(names.some(name => name.startsWith(`${app.name}_sbf::`)), `No passing ${app.name} tests ran`);
}
// Compute-unit comparison against the v1.53 ELFs' metrics from npm test, where present.
const comparison = Object.fromEntries(['vault', 'vesting', 'exchange', 'batch'].map(name => {
  const read = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return [name, { v153: read(`build/${name}-metrics.json`), v157: read(path.join(stage, `${name}-metrics.json`)) }];
}));
const receipt = {
  version: 1, kind: 'bend-fogo-v157-application-acceptance', runId,
  scope: 'Rust application tests on classic LiteSVM 0.7.1; SBPFv0 ELFs built by buildProgram --target fogo-v0 (platform-tools v1.57)',
  sources: Object.fromEntries(['scripts/program.ts', 'scripts/build.ts', 'compiler/target-profile.ts',
    'compiler/sbf-call-depth.ts', 'runtime/memory.c', 'runtime/sbf.ld', 'tests/fogo-v157-programs.ts', 'tests/sbf.rs',
    'Cargo.toml', 'Cargo.lock', ...APPLICATIONS.map(app => `tests/${app.name}_sbf.rs`)].map(file => [file, hash(file)])),
  builds,
  tests: { filters: TEST_FILTERS, passed: Number(summary![2]), failed: Number(summary![3]), ignored: Number(summary![4]),
    names, log: path.relative(process.cwd(), log) },
  computeUnits: comparison,
};
fs.writeFileSync(path.join(runDir, 'acceptance.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`${receipt.tests.passed} Fogo SBPFv0 (v1.57) application tests passed on LiteSVM 0.7.1 (${receipt.tests.ignored} ignored); ` +
  `receipt ${path.relative(process.cwd(), path.join(runDir, 'acceptance.json'))}`);
