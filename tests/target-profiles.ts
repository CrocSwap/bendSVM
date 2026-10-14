// Modern solana-v3 ordinary-library acceptance: isolated profile outputs, producer
// refusals, native ABI checks, a Rust-linked SBPFv3 image and modern LiteSVM execution.
// Each run writes a fresh directory; earlier evidence is never overwritten.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLibrary } from '../compiler/library.ts';
import { buildPureLibrary } from '../scripts/build-library.ts';
import { run } from '../scripts/build.ts';
import {
  assertLibraryObject, assertLibrarySections, legacyLibraryTarget, libraryOutputStem, libraryTarget, libraryTools,
  MODERN_TOOL_HASHES,
} from '../compiler/target-profile.ts';
import { checkSbfCallDepth } from '../compiler/sbf-call-depth.ts';

const source = 'tests/mixed-library/PROOF.bend';
const bendRoot = 'mixed.evaluate';
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
const root = `build/target-profiles/${runId}`;
const modern = libraryTarget('solana-v3');
const legacy = libraryTarget('fogo-v0');
const historical = legacyLibraryTarget();
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = (file: string) => ({ bytes: fs.statSync(file).size, sha256: hash(file) });
const SENTINEL = 0x1122334455667788n;

const acceptanceInputs = [
  'tests/target-profiles.ts', 'tests/mixed-library-sbf.rs', 'tests/mixed-library/program.rs',
  'tests/mixed-library/host.c', 'tests/mixed-library/PROOF.bend', 'tests/mixed-library/LAWS.bend',
  'tests/mixed-library/mixed.bend', 'tests/mixed-library/fixture.md',
  'compiler/target-profile.ts', 'compiler/library.ts', 'scripts/build-library.ts', 'scripts/build.ts',
  'runtime/memory.c', 'scripts/modern-library-runner/Cargo.toml', 'scripts/modern-library-runner/Cargo.lock',
  'scripts/modern-library-runner/src/main.rs', 'package.json', 'package-lock.json',
  '.deps/bend/bend2/bend.ts',
];
const startHashes = Object.fromEntries(acceptanceInputs.map(file => [file, hash(file)]));
const assertInputsUnchanged = (when: string) => {
  for (const [file, expected] of Object.entries(startHashes)) {
    assert.equal(hash(file), expected, `Acceptance input changed ${when}: ${file}`);
  }
};

type Exit = { name: string; command: string[]; status: number | null; output: string };
const exits: Exit[] = [];
function spawnRecorded(name: string, command: string, args: string[], env: Record<string, string | undefined> = {}): Exit {
  const child = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  const result = { name, command: [command, ...args], status: child.status,
    output: `${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? String(child.error) : ''}` };
  exits.push(result);
  return result;
}
function expectRefusal(name: string, result: Exit, pattern: RegExp) {
  assert.notEqual(result.status, 0, `${name} must fail: ${result.output}`);
  assert.match(result.output, pattern, `${name} must fail for the expected reason: ${result.output}`);
}

fs.mkdirSync(root, { recursive: true });
console.log(`solana-v3 library acceptance run ${root}`);

// 1. Explicit profiles publish into disjoint directories with one ABI identity.
const v3Manifest = await buildPureLibrary(source, bendRoot, `${root}/library`, 'solana-v3');
const v0Manifest = await buildPureLibrary(source, bendRoot, `${root}/library`, 'fogo-v0');
const v3Stem = libraryOutputStem(`${root}/library`, 'solana-v3');
const v0Stem = libraryOutputStem(`${root}/library`, 'fogo-v0');
assert.equal(v3Stem, `${root}/solana-v3/v1.57/library`);
assert.equal(v0Stem, `${root}/fogo-v0/v1.57/library`);
assert.equal(libraryOutputStem(`${root}/library`), `${root}/library`, 'Historical command keeps its output stem');
for (const [manifest, stem, profile] of [[v3Manifest, v3Stem, modern], [v0Manifest, v0Stem, legacy]] as const) {
  assert.equal(manifest.targetProfile, profile.name);
  assert.equal(manifest.toolchains.anzaClang.platformTools, profile.platformTools);
  assert.equal(manifest.toolchains.anzaClang.cpu, profile.cpu);
  assert.equal(manifest.toolchains.anzaClang.sbpfVersion, profile.sbpfVersion);
  assert.equal(manifest.finalElfAuthorized, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${stem}.manifest.json`, 'utf8')), manifest);
  for (const [basename, artifact] of Object.entries(manifest.artifacts as Record<string, { bytes: number; sha256: string }>)) {
    assert.deepEqual(record(path.join(path.dirname(stem), basename)), artifact, `${profile.name} artifact ${basename}`);
  }
  assertLibraryObject(`${stem}.sbf.o`, profile);
  assertLibraryObject(`${stem}.sbf.memory.o`, profile);
}
assert.equal(v3Manifest.symbol, v0Manifest.symbol, 'Target profile must not change the ABI symbol');
assert.equal(v3Manifest.schemaFingerprint, v0Manifest.schemaFingerprint);
assert.equal(v3Manifest.canonicalInputBytes, 6);
assert.equal(v3Manifest.canonicalOutputBytes, 5);
assert.equal(fs.readFileSync(`${v3Stem}.h`, 'utf8'), fs.readFileSync(`${v0Stem}.h`, 'utf8'));
assert.equal(fs.readFileSync(`${v3Stem}.bindings.rs`, 'utf8'), fs.readFileSync(`${v0Stem}.bindings.rs`, 'utf8'));
assert.notEqual(hash(`${v3Stem}.sbf.o`), hash(`${v0Stem}.sbf.o`));
for (const manifest of [v3Manifest, v0Manifest]) {
  assert.equal(manifest.toolchains.anzaClang.compilerBinarySha256, MODERN_TOOL_HASHES.clang);
}
assert.equal(v3Manifest.toolchains.anzaClang.compilerBinarySha256, MODERN_TOOL_HASHES.clang);
assert.equal(v3Manifest.toolchains.anzaReadelf.compilerBinarySha256, MODERN_TOOL_HASHES['llvm-readelf']);
console.log(`Isolated fogo-v0 and solana-v3 outputs share symbol ${v3Manifest.symbol}`);

// A same-root, same-width schema variant supplies the wrong-interface binding.
const variantSource = `${root}/schema-variant-source`;
fs.mkdirSync(variantSource, { recursive: true });
fs.copyFileSync('tests/mixed-library/PROOF.bend', `${variantSource}/PROOF.bend`);
for (const file of ['mixed.bend', 'LAWS.bend']) {
  fs.writeFileSync(`${variantSource}/${file}`, fs.readFileSync(`tests/mixed-library/${file}`, 'utf8')
    .replaceAll('Decision', 'Outcome').replaceAll('Accepted', 'Approved').replaceAll('Refused', 'Declined'));
}
const variantManifest = await buildPureLibrary(`${variantSource}/PROOF.bend`, bendRoot, `${root}/schema-variant/library`, 'solana-v3');
const variantStem = libraryOutputStem(`${root}/schema-variant/library`, 'solana-v3');
assert.equal(variantManifest.root, bendRoot);
assert.equal(variantManifest.canonicalInputBytes, v3Manifest.canonicalInputBytes);
assert.equal(variantManifest.canonicalOutputBytes, v3Manifest.canonicalOutputBytes);
assert.notEqual(variantManifest.symbol, v3Manifest.symbol);

// 2. Producer refusals.
const cli = (args: string[], env: Record<string, string | undefined> = {}) =>
  [process.execPath, ['scripts/build-library.ts', source, bendRoot, ...args], env] as const;
const refusalsRoot = `${root}/refusals`;
expectRefusal('unknown-profile', spawnRecorded('unknown-profile',
  ...cli([`${refusalsRoot}/unknown/library`, '--target', 'solana-v4'])), /Unknown library target solana-v4/);
expectRefusal('missing-profile-value', spawnRecorded('missing-profile-value',
  ...cli([`${refusalsRoot}/missing/library`, '--target'])), /Usage:/);
const v0Tools = libraryTools(historical);
expectRefusal('v0-tools-for-v3', spawnRecorded('v0-tools-for-v3',
  ...cli([`${refusalsRoot}/wrong-tools/library`, '--target', 'solana-v3'], { SBF_V157_TOOLS: v0Tools })),
  /Expected Anza platform-tools v1\.57 clang 22\.1\.2 for solana-v3/);
const v3Tools = libraryTools(modern);
const shimTools = path.resolve(`${refusalsRoot}/content-shim-tools`);
fs.mkdirSync(shimTools, { recursive: true });
fs.writeFileSync(path.join(shimTools, 'clang'),
  `#!/bin/sh\nexec ${JSON.stringify(path.join(v3Tools, 'clang'))} "$@"\n`, { mode: 0o755 });
fs.symlinkSync(path.join(v3Tools, 'llvm-readelf'), path.join(shimTools, 'llvm-readelf'));
expectRefusal('tool-content-pin', spawnRecorded('tool-content-pin',
  ...cli([`${refusalsRoot}/content/library`, '--target', 'solana-v3'], { SBF_V157_TOOLS: shimTools })),
  /does not match the platform-tools v1\.57 content pin/);
// SBF_TOOLS selects only the v0 profile; pointing it elsewhere must not alter a v3 build.
expectRefusal('v1.53-tools-for-explicit-fogo', spawnRecorded('v1.53-tools-for-explicit-fogo',
  ...cli([`${refusalsRoot}/fogo-wrong-tools/library`, '--target', 'fogo-v0'], { SBF_V157_TOOLS: v0Tools })),
  /Expected Anza platform-tools v1\.57 clang 22\.1\.2 for fogo-v0/);
expectRefusal('fogo-tool-content-pin', spawnRecorded('fogo-tool-content-pin',
  ...cli([`${refusalsRoot}/fogo-content/library`, '--target', 'fogo-v0'], { SBF_V157_TOOLS: shimTools })),
  /does not match the platform-tools v1\.57 content pin/);
// The historical command keeps v1.53 (any host); v1.57 tools in SBF_TOOLS are refused.
expectRefusal('v1.57-tools-for-historical', spawnRecorded('v1.57-tools-for-historical',
  ...cli([`${refusalsRoot}/v0-wrong-tools/library`], { SBF_TOOLS: v3Tools })),
  /Expected Anza platform-tools v1\.53 clang 20\.1\.7 for fogo-v0/);
for (const stem of ['unknown', 'missing', 'wrong-tools', 'content', 'fogo-wrong-tools', 'fogo-content', 'v0-wrong-tools']) {
  for (const profile of [undefined, 'solana-v3', 'fogo-v0'] as const) {
    const manifest = `${libraryOutputStem(`${refusalsRoot}/${stem}/library`, profile)}.manifest.json`;
    assert.equal(fs.existsSync(manifest), false, `Refused build must not publish ${manifest}`);
  }
}
// A stem already holding another profile's manifest is refused and left intact.
const collisionStem = `${refusalsRoot}/collision/library`;
fs.mkdirSync(path.dirname(collisionStem), { recursive: true });
fs.copyFileSync(`${v0Stem}.manifest.json`, `${collisionStem}.manifest.json`);
const collisionBefore = hash(`${collisionStem}.manifest.json`);
await assert.rejects(() => buildLibrary(source, bendRoot, collisionStem, 'solana-v3'),
  /Refusing to overwrite a library from another target/);
// Same profile name, other platform-tools: also refused.
await assert.rejects(() => buildLibrary(source, bendRoot, collisionStem),
  /Refusing to overwrite a library from another target/);
assert.equal(hash(`${collisionStem}.manifest.json`), collisionBefore);
assert.equal(fs.existsSync(`${collisionStem}.sbf.o`), false);
// Object header and section checks.
assert.throws(() => assertLibraryObject(`${v0Stem}.sbf.o`, modern), /solana-v3 requires .*SBPFv3/);
assert.throws(() => assertLibraryObject(`${v3Stem}.sbf.o`, legacy), /fogo-v0 requires .*SBPFv0/);
const wrongMachine = `${refusalsRoot}/machine.sbf.o`;
const machineBytes = fs.readFileSync(`${v3Stem}.sbf.o`);
machineBytes.writeUInt16LE(legacy.machine, 18);
fs.writeFileSync(wrongMachine, machineBytes);
assert.throws(() => assertLibraryObject(wrongMachine, modern), /solana-v3 requires/);
const writable = `${refusalsRoot}/writable`;
fs.writeFileSync(`${writable}.c`, 'int bend_counter = 7;\nint bend_bump(void) { return ++bend_counter; }\n');
run(path.join(v3Tools, 'clang'), ['--target=sbf', '-mcpu=v3', '-O2', '-c', `${writable}.c`, '-o', `${writable}.o`]);
assertLibraryObject(`${writable}.o`, modern);
assert.throws(() => assertLibrarySections(path.join(v3Tools, 'llvm-readelf'), `${writable}.o`, modern),
  /writable section \.data/);
console.log('Producer refused unknown/missing profiles, wrong tools, tool content, cross-profile stems, headers and writable sections');

// 3. Native ABI harness against the actual v3 bundle's host object.
const hostCompiler = process.env.CC ?? 'clang';
run(hostCompiler, ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', `-I${path.dirname(v3Stem)}`,
  'tests/mixed-library/host.c', `${v3Stem}.host.o`, '-o', `${root}/host-test`]);
run(path.resolve(`${root}/host-test`), []);
console.log('Native harness passed against the solana-v3 bundle host object');

// 4. Rust/Bend SBPFv3 link with the v1.57 Rust toolchain.
const rustcLauncher = path.resolve(v3Tools, '../../rust/bin/rustc');
const rustVersion = run(rustcLauncher, ['--version', '--verbose'], true);
assert(rustVersion.includes('1.95.0-dev') && rustVersion.includes('LLVM version: 22.1.2'),
  `Expected the Rust compiler shipped with Anza platform-tools v1.57: ${rustVersion}`);
const rustTarget = 'sbpfv3-solana-solana';
const sysroot = run(rustcLauncher, ['--print', 'sysroot'], true);
const targetLibdir = run(rustcLauncher, ['--print', 'target-libdir', '--target', rustTarget], true);
const targetSpec = JSON.parse(run(rustcLauncher,
  ['--print', 'target-spec-json', '-Z', 'unstable-options', '--target', rustTarget], true));
assert.equal(targetSpec.cpu, 'v3');
assert.equal(targetSpec.features, '+static-syscalls');
assert.equal(targetSpec.linker, 'rust-lld');
const rustLinker = path.join(sysroot, 'lib/rustlib/aarch64-apple-darwin/bin', targetSpec.linker);
const targetLibraries = fs.readdirSync(targetLibdir).sort().filter(file => file.endsWith('.rlib'))
  .map(file => ({ file, ...record(path.join(targetLibdir, file)) }));
assert(targetLibraries.some(entry => entry.file.startsWith('libcompiler_builtins-')));
const linkDir = `${root}/link`;
fs.mkdirSync(linkDir, { recursive: true });
const rustFlags = (object: string | null, noUndefined = true) => ['--edition=2021', '--crate-type=cdylib', '--target', rustTarget,
  '-C', 'target-cpu=v3', '-C', 'opt-level=2', '-C', 'panic=abort', '-Z', 'emit-stack-sizes=yes',
  ...(noUndefined ? ['-C', 'link-arg=--no-undefined'] : []), ...(object ? ['-C', `link-arg=${path.resolve(object)}`] : [])];
const link = (name: string, bindings: string, object: string | null, output: string, extra: string[] = []) =>
  spawnRecorded(name, rustcLauncher, [...rustFlags(object), ...extra, 'tests/mixed-library/program.rs', '-o', output],
    { BEND_LIBRARY_BINDINGS: path.resolve(bindings) });
const elf = `${linkDir}/mixed-library.so`;
const linked = link('link-v3', `${v3Stem}.bindings.rs`, `${v3Stem}.sbf.o`, elf);
assert.equal(linked.status, 0, `v3 Rust/Bend link failed: ${linked.output}`);

const readelf = path.join(v3Tools, 'llvm-readelf');
function assertModernFinalImage(file: string, symbol: string) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 7).toString('hex'), '7f454c46020101');
  assert.equal(bytes.readUInt16LE(16), 3, 'Final image must be ET_DYN');
  assert.equal(bytes.readUInt16LE(18), modern.machine);
  assert.equal(bytes.readUInt32LE(48), modern.sbpfVersion);
  const symbols = run(readelf, ['-s', '-W', file], true);
  const imports = symbols.split('\n').filter(line => /\bUND\b/.test(line))
    .map(line => line.trim().split(/\s+/).at(-1)!).filter(name => name !== 'UND');
  assert.deepEqual(imports, [], `solana-v3 final image must not import symbols: ${imports.join(', ')}`);
  assert(symbols.split('\n').some(line => line.trim().endsWith(symbol)), `Final image lacks ${symbol}`);
  assert.match(run(readelf, ['-r', file], true), /There are no relocations in this file/);
  assertLibrarySections(readelf, file, modern);
  return symbols;
}
const finalSymbols = assertModernFinalImage(elf, v3Manifest.symbol);
const stackSizes = run(readelf, ['--stack-sizes', elf], true);
const frames = [...stackSizes.matchAll(/^\s+(\d+)\s+\S+/gm)].map(match => Number(match[1]));
assert(frames.length > 0, `Stack-size metadata missing: ${stackSizes}`);
const rustMaxFrameBytes = Math.max(...frames);
assert(rustMaxFrameBytes <= 4096, `Rust SBF frame exceeds 4096 bytes: ${rustMaxFrameBytes}`);
fs.writeFileSync(`${linkDir}/symbols.txt`, finalSymbols);
fs.writeFileSync(`${linkDir}/stack-sizes.txt`, stackSizes);

// Wrong interface: --no-undefined turns the unresolved variant symbol into a link failure.
const wrongElf = `${linkDir}/schema-mismatch.so`;
const wrong = link('link-wrong-interface', `${variantStem}.bindings.rs`, `${v3Stem}.sbf.o`, wrongElf);
expectRefusal('link-wrong-interface', wrong, new RegExp(`undefined symbol: ${variantManifest.symbol}`));
assert.equal(fs.existsSync(wrongElf), false);
const missing = link('link-missing-object', `${v3Stem}.bindings.rs`, null, `${linkDir}/missing-object.so`);
expectRefusal('link-missing-object', missing, new RegExp(`undefined symbol: ${v3Manifest.symbol}`));
// Without --no-undefined the linker emits an image with an unresolved call; the final-image gate refuses it.
const hazardElf = `${linkDir}/unchecked-wrong-interface.so`;
const hazard = spawnRecorded('link-wrong-interface-without-no-undefined', rustcLauncher,
  [...rustFlags(`${v3Stem}.sbf.o`, false), 'tests/mixed-library/program.rs', '-o', hazardElf],
  { BEND_LIBRARY_BINDINGS: path.resolve(`${variantStem}.bindings.rs`) });
assert.equal(hazard.status, 0, `Hazard control should link without --no-undefined: ${hazard.output}`);
assert.throws(() => assertModernFinalImage(hazardElf, variantManifest.symbol), /must not import symbols/);
console.log('Linked SBPFv3 image has no imports/relocations; wrong-interface and missing-object links refused');

// 5. Independent expected reports for the 15 Rust/Bend cases.
const rustTest = fs.readFileSync('tests/mixed-library-sbf.rs', 'utf8');
const statusNumbers: Record<string, number> = { OK: 0, NULL: 1, RANGE: 2, ALIAS: 3, MALFORMED_INPUT: 4,
  SHORT_OUTPUT: 5, MISALIGNED_OUTPUT_LEN: 6, OUTPUT_ENCODING: 7 };
const rustCases = [...rustTest.matchAll(/\("([a-z0-9_]+)", vec!\[([0-9, ]+)\], BEND_LIBRARY_ABI_([A-Z_]+),/g)]
  .map(match => ({ name: match[1], data: match[2].split(',').map(value => Number(value.trim())),
    rustStatus: statusNumbers[match[3]] }));
assert.equal(rustCases.length, 15, 'Expected the 15 cases of tests/mixed-library-sbf.rs');
const u32 = (bytes: number[], offset: number) =>
  (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
const le = (value: bigint, width: number) =>
  Array.from({ length: width }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
// Reference semantics from fixture.md, independent of generated code.
function evaluate(payload: number[]): number[] | null {
  if (payload.length !== 6) return null;
  const decision = (tag: number, value: number) => [tag, ...le(BigInt(value), 4)];
  if (payload[0] === 0) {
    if (payload[1] > 1) return null;
    const value = u32(payload, 2);
    if (payload[1] === 0) return decision(1, value);
    return value < 41 ? decision(0, value + 2) : decision(1, value);
  }
  if (payload[0] === 1) return payload.slice(1).every(byte => byte === 0) ? decision(1, 0) : null;
  return null;
}
// Status precedence: null, range, alignment, alias, input, capacity, encoding (program.rs modes).
function expected(data: number[]) {
  const mode = data[0];
  const payload = data.slice(1);
  const result = evaluate(payload);
  const status = mode === 5 || mode === 6 ? 1 : mode === 7 ? 6 : mode === 4 ? 3 :
    result === null ? 4 : mode === 1 || mode === 3 ? 5 : 0;
  const output = status === 0 ? result! : Array(5).fill(0xa5);
  const outputLength = status === 0 ? 5n : SENTINEL;
  let before = data.length;
  for (const byte of data) before = (before + byte) >>> 0;
  let after = (before ^ status ^ Number(outputLength & 0xffffffffn)) >>> 0;
  for (const byte of output) after = (Math.imul(after, 33) + byte) >>> 0;
  return { status, report: [1, mode, ...le(BigInt(status), 4), ...le(outputLength, 8), status === 0 ? 0 : 1,
    ...le(BigInt(before), 4), ...le(BigInt(after), 4), ...output] };
}
const cases = rustCases.map(entry => {
  const { status, report } = expected(entry.data);
  assert.equal(status, entry.rustStatus, `Reference status differs from tests/mixed-library-sbf.rs: ${entry.name}`);
  assert.equal(report.length, 28);
  return { name: entry.name, data: entry.data, expected: report };
});
fs.writeFileSync(`${linkDir}/cases.json`, JSON.stringify(cases, null, 2) + '\n');

// 6. Modern LiteSVM 0.13.0 execution (simulation and submission, three runs).
const runnerManifest = 'scripts/modern-library-runner/Cargo.toml';
const runnerTarget = path.resolve('target/modern-library-cargo');
const cargoBuild = spawnRecorded('runner-build', 'cargo', ['build', '--release', '--locked', '--offline',
  '--manifest-path', runnerManifest, '--target-dir', runnerTarget]);
assert.equal(cargoBuild.status, 0, `Modern runner build failed: ${cargoBuild.output}`);
const runner = path.join(runnerTarget, 'release/bend-modern-library-runner');
const execution = spawnRecorded('runner-execute', runner, [path.resolve(linkDir), path.resolve(hazardElf)]);
assert.equal(execution.status, 0, `Modern runner failed: ${execution.output}`);
const runtimeReport = JSON.parse(fs.readFileSync(`${linkDir}/runtime-report.json`, 'utf8'));
assert.equal(runtimeReport.passed, true);
assert.equal(runtimeReport.cases, 15);
assert.equal(runtimeReport.runs.length, 3);
assert.deepEqual(runtimeReport.runs[0].map((entry: any) => entry.returnData), cases.map(entry => entry.expected));
assert.deepEqual(runtimeReport.runtimePatches, []);
// The runner must compare actual return data: a one-byte expectation change fails.
const tamperedDir = `${root}/tampered-expectation`;
fs.mkdirSync(tamperedDir, { recursive: true });
fs.copyFileSync(elf, `${tamperedDir}/mixed-library.so`);
const tampered = structuredClone(cases);
tampered[1].expected[tampered[1].expected.length - 4] ^= 1;
fs.writeFileSync(`${tamperedDir}/cases.json`, JSON.stringify(tampered, null, 2) + '\n');
expectRefusal('runner-tampered-expectation', spawnRecorded('runner-tampered-expectation', runner, [path.resolve(tamperedDir)]),
  new RegExp(cases[1].name));
assert.equal(fs.existsSync(`${tamperedDir}/runtime-report.json`), false);
console.log(execution.output.trim());

// 6b. fogo-v0 at v1.57: Rust link, v0 final-image gate, execution on both feature sets.
const v0LinkDir = `${root}/link-fogo-v0`;
fs.mkdirSync(v0LinkDir, { recursive: true });
const v0Program = `${v0LinkDir}/program.rs`;
const programSource = fs.readFileSync('tests/mixed-library/program.rs', 'utf8');
const v0ProgramSource = programSource.replace('../../build/mixed-library/library.bindings.rs',
  path.resolve(`${v0Stem}.bindings.rs`));
assert.notEqual(v0ProgramSource, programSource);
fs.writeFileSync(v0Program, v0ProgramSource);
const v0RustTarget = 'sbpf-solana-solana';
const v0Elf = `${v0LinkDir}/mixed-library.so`;
const v0Link = spawnRecorded('link-fogo-v0', rustcLauncher, ['--edition=2021', '--crate-type=cdylib',
  '--target', v0RustTarget, '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort',
  '-Z', 'emit-stack-sizes=yes', '-C', `link-arg=${path.resolve(`${v0Stem}.sbf.o`)}`, v0Program, '-o', v0Elf]);
assert.equal(v0Link.status, 0, `fogo-v0 Rust/Bend link failed: ${v0Link.output}`);
const v0Bytes = fs.readFileSync(v0Elf);
assert.equal(v0Bytes.readUInt16LE(16), 3, 'fogo-v0 final image must be ET_DYN');
assert.equal(v0Bytes.readUInt32LE(48), 0, 'fogo-v0 final image must be SBPFv0');
const v0Machine = v0Bytes.readUInt16LE(18);
assert([247, 263].includes(v0Machine), `Unexpected fogo-v0 machine ${v0Machine}`);
const v0Symbols = run(readelf, ['-s', '-W', v0Elf], true);
assert(v0Symbols.includes(v0Manifest.symbol), 'fogo-v0 image lacks the Bend export');
const v0Imports = [...new Set(v0Symbols.split('\n').filter(line => /\bUND\b/.test(line))
  .map(line => line.trim().split(/\s+/).at(-1)!).filter(name => name !== 'UND'))].sort();
const v0AllowedImports = new Set(['abort', 'sol_set_return_data', 'sol_memcpy_', 'sol_memmove_', 'sol_memset_', 'sol_memcmp_']);
for (const name of v0Imports) assert(v0AllowedImports.has(name), `Unexpected fogo-v0 import: ${name}`);
const v0CallDepth = checkSbfCallDepth(new Uint8Array(v0Bytes));
assert.equal(v0CallDepth.status, 'accepted',
  `v0 call-depth gate must accept the v1.57 fogo-v0 image: ${JSON.stringify(v0CallDepth.diagnostics ?? v0CallDepth).slice(0, 2000)}`);
fs.writeFileSync(`${v0LinkDir}/call-depth.json`, JSON.stringify(v0CallDepth, null, 2) + '\n');
fs.copyFileSync(`${linkDir}/cases.json`, `${v0LinkDir}/cases.json`);
// v0 keeps imports dynamic, so a wrong-interface binding links and the loader must refuse it.
const v0WrongProgram = `${v0LinkDir}/schema-mismatch-program.rs`;
fs.writeFileSync(v0WrongProgram, programSource.replace('../../build/mixed-library/library.bindings.rs',
  path.resolve(`${variantStem}.bindings.rs`)));
const v0WrongElf = `${v0LinkDir}/schema-mismatch.so`;
const v0Wrong = spawnRecorded('link-fogo-v0-wrong-interface', rustcLauncher, ['--edition=2021', '--crate-type=cdylib',
  '--target', v0RustTarget, '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort',
  '-C', `link-arg=${path.resolve(`${v0Stem}.sbf.o`)}`, v0WrongProgram, '-o', v0WrongElf]);
assert.equal(v0Wrong.status, 0, `fogo-v0 wrong-interface control should link: ${v0Wrong.output}`);
assert(run(readelf, ['-s', '-W', v0WrongElf], true).split('\n')
  .some(line => /\bUND\b/.test(line) && line.trim().endsWith(variantManifest.symbol)));
const v0Runtime: Record<string, any> = {};
for (const policy of ['all-enabled', 'mainnet']) {
  const directory = `${v0LinkDir}/${policy}`;
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(v0Elf, `${directory}/mixed-library.so`);
  fs.copyFileSync(`${linkDir}/cases.json`, `${directory}/cases.json`);
  const executed = spawnRecorded(`runner-fogo-v0-${policy}`, runner,
    [path.resolve(directory), '--features', policy, path.resolve(v0WrongElf)]);
  assert.equal(executed.status, 0, `fogo-v0 runner (${policy}) failed: ${executed.output}`);
  const report = JSON.parse(fs.readFileSync(`${directory}/runtime-report.json`, 'utf8'));
  assert.equal(report.cases, 15);
  assert.equal(report.elfFlags, 0);
  assert.equal(report.loaderObservations[0].accepted, false, `${policy} loader must refuse the wrong-interface v0 image`);
  assert.deepEqual(report.runs[0].map((entry: any) => entry.returnData), cases.map(entry => entry.expected));
  v0Runtime[policy] = { maxCu: report.maxCu, activeFeatureCount: report.activeFeatureIds.length,
    wrongInterfaceLoad: report.loaderObservations[0] };
  console.log(`fogo-v0 (${policy}): ${executed.output.trim()}`);
}

// 7. Receipt.
assertInputsUnchanged('during solana-v3 acceptance');
const binary = (file: string) => ({ path: file, resolvedPath: fs.realpathSync(file), ...record(fs.realpathSync(file)) });
const runDirectoryFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? runDirectoryFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const acceptance = {
  version: 1,
  kind: 'bend-target-profile-acceptance',
  targetProfile: modern.name,
  scope: 'Rust/Bend ordinary library on local LiteSVM 0.13.0 all-enabled features; not network or Go validation',
  sourceHashes: startHashes,
  libraryManifests: {
    'solana-v3': { path: `${v3Stem}.manifest.json`, ...record(`${v3Stem}.manifest.json`) },
    'fogo-v0': { path: `${v0Stem}.manifest.json`, ...record(`${v0Stem}.manifest.json`) },
    'solana-v3-schema-variant': { path: `${variantStem}.manifest.json`, ...record(`${variantStem}.manifest.json`) },
  },
  identity: { root: bendRoot, symbol: v3Manifest.symbol, schemaFingerprint: v3Manifest.schemaFingerprint,
    canonicalInputBytes: v3Manifest.canonicalInputBytes, canonicalOutputBytes: v3Manifest.canonicalOutputBytes },
  toolchains: {
    bun: { ...binary(process.execPath), version: process.versions.bun },
    anzaClang: v3Manifest.toolchains.anzaClang,
    anzaReadelf: v3Manifest.toolchains.anzaReadelf,
    anzaRustc: { launcher: binary(rustcLauncher), version: rustVersion },
    rustLinker: { ...binary(rustLinker), version: run(rustLinker, ['-flavor', 'gnu', '--version'], true) },
    rustTarget, targetSpec: { cpu: targetSpec.cpu, features: targetSpec.features, linker: targetSpec.linker },
    targetLibraryDirectory: targetLibdir, targetLibraries,
    hostCargo: run('cargo', ['--version'], true), hostRustc: run('rustc', ['--version'], true),
    runner: binary(runner),
  },
  finalImage: { path: elf, ...record(elf), machine: modern.machine, flags: modern.sbpfVersion, imports: [],
    rustMaxFrameBytes, libraryMaxFrameBytes: v3Manifest.maxFrameBytes },
  fogoV0: { finalImage: { path: v0Elf, ...record(v0Elf), machine: v0Machine, flags: 0, imports: v0Imports },
    callDepth: { status: v0CallDepth.status, path: `${v0LinkDir}/call-depth.json` }, runtime: v0Runtime },
  runtime: { maxCu: runtimeReport.maxCu, cases: runtimeReport.cases, runs: runtimeReport.runs.length,
    activeFeatureCount: runtimeReport.activeFeatureIds.length, mainnetFeatureLoad: runtimeReport.mainnetFeatureLoad,
    loaderObservations: runtimeReport.loaderObservations, networkValidation: false },
  commands: exits,
  artifacts: Object.fromEntries(runDirectoryFiles(root).sort().map(file => [file, record(file)])),
};
fs.writeFileSync(`${root}/acceptance.json`, JSON.stringify(acceptance, null, 2) + '\n');
console.log(`solana-v3 library acceptance recorded in ${root}/acceptance.json`);
