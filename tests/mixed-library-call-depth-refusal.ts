import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyFinalSbfArtifactReceipt, type SbfCallDepthArtifactReceipt } from '../compiler/sbf-call-depth-artifact.ts';

const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const uniqueId = () => new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + crypto.randomUUID();

function readJson<T>(file: string): T {
  assert(fs.existsSync(file), 'Missing mixed-library evidence: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function copyTree(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function linkDirectory(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.resolve(source), destination, 'dir');
}

function injectRecursiveRustCall(programPath: string): void {
  const original = fs.readFileSync(programPath, 'utf8');
  const functionMarker = '#[no_mangle]\npub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {';
  const callMarker = '    let mode = *instruction;\n';
  assert.equal(original.split(functionMarker).length - 1, 1, 'test copy must find one Rust entrypoint');
  assert.equal(original.split(callMarker).length - 1, 1, 'test copy must find one instruction mode branch');
  const recursiveFunction = [
    '#[inline(never)]',
    '#[no_mangle]',
    'pub extern "C" fn sbf_call_depth_test(n: u64, value: u64) -> u64 {',
    '    if n == 0 { value } else {',
    '        let nested = sbf_call_depth_test(n.wrapping_sub(1), value.wrapping_add(n));',
    '        unsafe { core::ptr::read_volatile(&nested).wrapping_add(1) }',
    '    }',
    '}',
    '',
  ].join('\n');
  let changed = original.replace(functionMarker, recursiveFunction + functionMarker);
  changed = changed.replace(callMarker, callMarker + '    if mode == 255 { let _ = sbf_call_depth_test(4, 0); }\n');
  assert.notEqual(changed, original);
  fs.writeFileSync(programPath, changed);
}

function collectFiles(directory: string, result: string[] = []): string[] {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file, result);
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

export function testMixedLibraryCallDepthRefusal(): void {
const acceptance = readJson<{
  sourceHashes: Record<string, string>;
  sbfCallDepth: SbfCallDepthArtifactReceipt;
  rustArtifacts: { cargoTestBinary: { path: string; resolvedPath?: string; sha256: string } };
}>(path.resolve('build/mixed-library/acceptance.json'));
const goodElf = path.resolve('build/mixed-library/mixed-library.so');
const goodHash = hash(goodElf);
verifyFinalSbfArtifactReceipt(acceptance.sbfCallDepth, goodElf);
assert.equal(acceptance.sbfCallDepth.artifact.sha256, goodHash,
  'positive mixed acceptance must bind the current successful Rust/Bend ELF');
assert.equal(acceptance.sourceHashes['tests/mixed-library/program.rs'], hash('tests/mixed-library/program.rs'));
assert.equal(acceptance.sourceHashes['tests/mixed-library-sbf.rs'], hash('tests/mixed-library-sbf.rs'));
assert.equal(acceptance.sourceHashes['tests/mixed-library.ts'], hash('tests/mixed-library.ts'));
const reusedRunner = acceptance.rustArtifacts.cargoTestBinary.path;
assert.equal(hash(reusedRunner), acceptance.rustArtifacts.cargoTestBinary.sha256,
  'reuse only the exact LiteSVM test executable recorded by the successful mixed acceptance');

const id = uniqueId();
const probeRoot = path.resolve('build/mixed-library-call-depth-probes', id);
fs.mkdirSync(probeRoot, { recursive: true });
for (const directory of ['compiler', 'runtime', 'scripts', 'sdk', 'examples']) {
  linkDirectory(directory, path.join(probeRoot, directory));
}
for (const file of ['Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json']) {
  fs.copyFileSync(file, path.join(probeRoot, file));
}
for (const file of ['tests/mixed-library.ts', 'tests/mixed-library-sbf.rs', 'tests/sbf.rs']) {
  const destination = path.join(probeRoot, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}
copyTree('tests/mixed-library', path.join(probeRoot, 'tests/mixed-library'));
linkDirectory('.deps', path.join(probeRoot, '.deps'));
linkDirectory('node_modules', path.join(probeRoot, 'node_modules'));
const mixedTarget = path.resolve('target/mixed-library-cargo');
assert(fs.existsSync(path.join(mixedTarget, 'debug', 'deps')),
  'run the successful mixed pipeline first so its local Cargo cache can be reused');
fs.mkdirSync(path.join(probeRoot, 'target'), { recursive: true });
fs.symlinkSync(mixedTarget, path.join(probeRoot, 'target/mixed-library-cargo'), 'dir');

const copiedHarness = path.join(probeRoot, 'tests/mixed-library.ts');
const harnessSource = fs.readFileSync(copiedHarness, 'utf8');
const cargoCommand = "  run('cargo', ['test', '--locked', '--test', 'mixed-library-sbf', '--', '--nocapture']);";
assert.equal(harnessSource.split(cargoCommand).length - 1, 1,
  'private probe must patch only the Cargo command, not the final-ELF gate');
const reuseCommand = "  run(path.resolve('target/mixed-library-cargo/debug/deps/" + path.basename(reusedRunner) + "'), ['--nocapture']);";
fs.writeFileSync(copiedHarness, harnessSource.replace(cargoCommand, reuseCommand));

const copiedProgram = path.join(probeRoot, 'tests/mixed-library/program.rs');
const copiedProgramBefore = fs.readFileSync(copiedProgram, 'utf8');
assert.equal(hash(copiedProgram), acceptance.sourceHashes['tests/mixed-library/program.rs']);
injectRecursiveRustCall(copiedProgram);
assert.notEqual(hash(copiedProgram), acceptance.sourceHashes['tests/mixed-library/program.rs'],
  'the refusal control must change the private Rust program input');
assert.match(fs.readFileSync(copiedProgram, 'utf8'), /sbf_call_depth_test\(4, 0\)/);
assert.match(copiedProgramBefore, /pub unsafe extern "C" fn entrypoint/);

const result = spawnSync(process.execPath, ['tests/mixed-library.ts'], {
  cwd: probeRoot,
  encoding: 'utf8',
  env: process.env,
});
const output = (result.stdout ?? '') + (result.stderr ?? '');
assert.equal(result.error, undefined, 'private mixed pipeline must start successfully');
assert.notEqual(result.status, 0, 'recursive mixed final ELF must be refused');
assert.match(output, /Pinned Anza Rust\/Clang linked the root\/schema-specific Bend object/,
  'the Rust/Bend final link must complete before semantic refusal');
assert.match(output, /15 mixed Rust\/Bend SBF cases passed/,
  'the positive runtime control must complete before the private refusal probe');
assert.match(output, /SBF_CALL_DEPTH_REFUSED/);
assert.match(output, /recursive_call_graph/);
assert.doesNotMatch(output, /rustc failed|cargo failed|ld\.lld failed|Cannot locate compiler executable/);

const refusedCandidates = collectFiles(path.join(probeRoot, 'build/mixed-library-sbf-call-depth-refused'))
  .filter(file => path.basename(file) === 'mixed-library.so');
assert.equal(refusedCandidates.length, 1, 'the mixed refusal path must quarantine exactly one final ELF');
const refusedElf = refusedCandidates[0];
assert.notEqual(hash(refusedElf), goodHash,
  'the recursive mixed final ELF must differ from the current successful pipeline artifact');
assert.equal(fs.existsSync(path.join(probeRoot, 'build/mixed-library/mixed-library.so')), false,
  'the refused mixed ELF must be unavailable at its ordinary artifact path');
assert.equal(fs.existsSync(path.join(probeRoot, 'build/mixed-library/acceptance.json')), false,
  'the refused mixed run must not publish acceptance.json');
assert(fs.existsSync(path.join(probeRoot, 'build/mixed-library/library.sbf.o')),
  'the Bend relocatable object must be retained as pipeline evidence');

const refusedHash = hash(refusedElf);
const reports = collectFiles(path.join(probeRoot, 'build/mixed-library/sbf-call-depth'))
  .filter(file => path.basename(file).startsWith('sbf-call-depth-') && file.endsWith('.json'))
  .map(file => ({ file, value: readJson<any>(file) }))
  .filter(({ value }) => value.status === 'refused' && value.artifact?.sha256 === refusedHash);
assert.equal(reports.length, 1, 'semantic refusal report must bind the quarantined mixed ELF');
assert.equal(reports[0].value.refusal.code, 'SBF_CALL_DEPTH_REFUSED');
assert(reports[0].value.checkerReport.diagnostics.some((diagnostic: { code: string }) =>
  diagnostic.code === 'recursive_call_graph'));
assert.equal(reports[0].value.checker.sha256, hash(path.resolve('compiler/sbf-call-depth.ts')));
assert.equal(reports[0].value.artifact.byteLength, fs.statSync(refusedElf).size);

console.log('Mixed Rust/Bend pipeline control passed; a linked recursive final ELF was semantically refused and quarantined');
}

if (import.meta.main) testMixedLibraryCallDepthRefusal();
