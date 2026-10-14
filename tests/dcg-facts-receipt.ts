import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { receiptError } from './dcg-facts.ts';

const invokedRoot = process.cwd();
let root = invokedRoot;
let runner = '';
let canonicalDir = '';
let canonicalReport = '';
let runsDir = '';
let probesDir = '';
let header = '';

function sha(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function inventorySha256(files: Record<string, string>): string {
  return sha(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, digest]) => `${file}\0${digest}\n`).join(''));
}
function existingRuns(): Set<string> {
  if (!fs.existsSync(runsDir)) return new Set();
  return new Set(fs.readdirSync(runsDir).filter(name => fs.statSync(path.join(runsDir, name)).isDirectory()));
}
function newRun(before: Set<string>): string {
  const current = [...existingRuns()].filter(name => !before.has(name));
  assert.equal(current.length, 1, `one fresh runner directory was created, found: ${current.join(', ')}`);
  return path.join(runsDir, current[0]);
}
function runSync(extraEnv: Record<string, string> = {}, args: string[] = []): { status: number | null; stdout: string; stderr: string; runDir: string } {
  const before = existingRuns();
  const child = spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  if (child.error) throw new Error(`runner spawn failed: ${child.error.message}`);
  const runDir = newRun(before);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, runDir };
}
function failureReceipt(runDir: string, expectedCode: string, output: string): Record<string, any> {
  assert.notEqual(output, '', 'parent runner produced a diagnostic');
  assert.match(output, new RegExp(`\\[${expectedCode}\\]`), `parent diagnostic identifies ${expectedCode}`);
  const receiptPath = path.join(runDir, 'acceptance-failed.json');
  assert.ok(fs.existsSync(receiptPath), `parent wrote ${receiptPath}`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.diagnosticCode, expectedCode);
  assert.equal(receipt.successReportPublished, false);
  assert.equal(receipt.artifactRoot, path.relative(root, runDir));
  for (const [relative, digest] of Object.entries(receipt.artifactOutputSha256 as Record<string, string>)) {
    assert.ok(relative.startsWith(path.relative(root, runDir) + path.sep), `failed-run artifact belongs to this run: ${relative}`);
    assert.equal(sha(fs.readFileSync(path.join(root, relative))), digest, `failed-run artifact digest ${relative}`);
  }
  return receipt;
}
function assertExactRawEntrypointLocation(report: Record<string, any>, handler: Record<string, any>): void {
  const rawUsagePath = path.join(root, report.artifactRoot, `dcg-tag-${handler.tag}.frame.su`);
  const expectedRawLocation = path.relative(root, path.join(root, report.artifactRoot,
    `dcg-tag-${handler.tag}.frame.c`)).split(path.sep).join('/') + ':4:entrypoint';
  const rawEntrypoints = fs.readFileSync(rawUsagePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map(line => line.split('\t', 3)).filter(([location]) => location?.endsWith(':entrypoint'));
  assert.deepEqual(rawEntrypoints,
    [[expectedRawLocation, String(handler.compiledFrame.entrypointBytes), 'static']],
    'raw Clang .su must preserve the exact generated frame path and line-4 entrypoint');
}
function executable(command: string): string {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`required probe tool ${command} could not be resolved`);
  return fs.realpathSync(result.stdout.trim());
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function wrapperSource(realClang: string, marker: string, release: string): string {
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${shellQuote(realClang)} "$@"; fi\nif [ ! -e ${shellQuote(marker)} ]; then\n  : > ${shellQuote(marker)}\n  while [ ! -e ${shellQuote(release)} ]; do /bin/sleep 0.05; done\nfi\nexec ${shellQuote(realClang)} "$@"\n`;
}
function createSbfTools(directory: string, realTools: Record<string, string>, clangWrapper: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'clang'), clangWrapper, { mode: 0o700 });
  fs.symlinkSync(realTools['ld.lld'], path.join(directory, 'ld.lld'));
  fs.symlinkSync(realTools['llvm-readelf'], path.join(directory, 'llvm-readelf'));
}
function nativeZeroWrapperSource(): string {
  return String.raw`#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int has_suffix(const char *value, const char *suffix) {
  size_t value_length = strlen(value), suffix_length = strlen(suffix);
  return value_length >= suffix_length && strcmp(value + value_length - suffix_length, suffix) == 0;
}

static int write_frame_stub(const char *source, const char *stub, int wrong_path) {
  if (wrong_path) {
    const char *basename = strrchr(source, '/');
    basename = basename ? basename + 1 : source;
    FILE *file = fopen(stub, "w");
    if (!file) return 0;
    if (fprintf(file, "#line 4 \"wrong-directory/%s\"\n", basename) < 0) { fclose(file); return 0; }
    fputs("void entrypoint(void) {\n"
      "  volatile unsigned char frame[64];\n"
      "  for (unsigned i = 0; i < sizeof(frame); ++i) frame[i] = (unsigned char)i;\n"
      "  (void)frame[sizeof(frame) - 1];\n"
      "}\n", file);
    return fclose(file) == 0;
  }
  char cwd[4096];
  if (!getcwd(cwd, sizeof(cwd))) return 0;
  const char *location = source;
  size_t cwd_length = strlen(cwd);
  if (strncmp(source, cwd, cwd_length) == 0 && source[cwd_length] == '/') location = source + cwd_length + 1;
  FILE *file = fopen(stub, "w");
  if (!file) return 0;
  fputs("#line 4 \"", file);
  for (const char *cursor = location; *cursor; cursor++) {
    if (*cursor == '\\' || *cursor == '"') fputc('\\', file);
    fputc(*cursor, file);
  }
  fputs("\"\nvoid entrypoint(void) {}\n", file);
  return fclose(file) == 0;
}

int main(int argc, char **argv) {
  const char *real_clang = getenv("DCG_REAL_CLANG");
  if (!real_clang || !*real_clang) return 125;
  argv[0] = (char *)real_clang;
  if (argc > 1 && strcmp(argv[1], "--version") == 0) {
    execv(real_clang, argv);
    return 127;
  }

  int compile_only = 0;
  int source_index = -1;
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "-c") == 0) compile_only = 1;
    if (has_suffix(argv[index], ".frame.c")) source_index = index;
  }
  const char *stub_directory = getenv("DCG_ZERO_STUB_DIR");
  if (!stub_directory || !*stub_directory) stub_directory = getenv("DCG_FRAME_STUB_DIR");
  const char *stub_mode = getenv("DCG_FRAME_STUB_MODE");
  if (compile_only && source_index >= 0 && stub_directory && *stub_directory) {
    char stub[4096];
    if (snprintf(stub, sizeof(stub), "%s/frame-stub-%ld.c", stub_directory, (long)getpid()) >= (int)sizeof(stub)) return 126;
    if (!write_frame_stub(argv[source_index], stub, stub_mode && strcmp(stub_mode, "wrong-path") == 0)) return 126;
    argv[source_index] = stub;
  }
  execv(real_clang, argv);
  return 127;
}
`;
}
function compileNativeZeroWrapper(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'native-zero-wrapper.c');
  const binary = path.join(directory, 'native-zero-wrapper');
  fs.writeFileSync(source, nativeZeroWrapperSource());
  const built = spawnSync(process.env.CC ?? 'clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', binary], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(built.error, undefined, `private native test wrapper compiler started: ${built.error?.message}`);
  assert.equal(built.status, 0, `private native test wrapper compiled: ${built.stderr}`);
  return binary;
}
async function waitForMarker(marker: string, child: ReturnType<typeof spawn>, exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = await exit;
      throw new Error(`parent exited before its compiler gate marker (code=${result.code}, signal=${result.signal}): ${result.stderr || result.stdout}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  const result = await exit;
  throw new Error(`timed out waiting for compiler gate marker; code=${result.code}, signal=${result.signal}`);
}
async function runAtCompilerGate(mode: 'source' | 'tool'): Promise<{ runDir: string; output: string }> {
  const directory = path.join(probesDir, `${mode}-drift-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, 'entered');
  const release = path.join(directory, 'release');
  const wrapper = path.join(directory, 'cc-wrapper.sh');
  const realClang = executable('clang');
  fs.writeFileSync(wrapper, wrapperSource(realClang, marker, release), { mode: 0o700 });

  const before = existingRuns();
  const child = spawn(process.execPath, [runner], {
    cwd: root, env: { ...process.env, CC: wrapper },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', error => reject(new Error(`runner spawn failed: ${error.message}`)));
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const originalHeader = fs.readFileSync(header);
  try {
    await waitForMarker(marker, child, exit);
    if (mode === 'source') fs.appendFileSync(header, '\n/* changed after parent capture */\n');
    else fs.appendFileSync(wrapper, '\n# changed after parent capture\n');
    fs.writeFileSync(release, 'continue\n');
    const result = await exit;
    assert.equal(result.signal, null, `${mode} drift probe completed without signal termination`);
    assert.equal(result.code, 1, `${mode} drift causes the actual parent gate to fail`);
    const runDir = newRun(before);
    const expected = mode === 'source' ? 'DCG-INPUT-DRIFT' : 'DCG-TOOL-DRIFT';
    failureReceipt(runDir, expected, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(canonicalReport), false, `${mode} drift did not leave a canonical success report`);
    return { runDir, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    fs.writeFileSync(release, 'continue\n');
    fs.writeFileSync(header, originalHeader);
  }
}
function replaceExactlyOnce(source: string, before: string, after: string): string {
  assert.equal(source.split(before).length - 1, 1, `source mutation target occurs once: ${before}`);
  return source.replace(before, after);
}
async function withRestoredSource<T>(file: string, mutate: (original: Buffer) => Buffer, action: () => Promise<T>): Promise<T> {
  const original = fs.readFileSync(file);
  const changed = mutate(original);
  fs.writeFileSync(file, changed);
  try { return await action(); }
  finally { fs.writeFileSync(file, original); }
}
async function withMissingSource<T>(file: string, action: () => Promise<T>): Promise<T> {
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  try { return await action(); }
  finally { fs.writeFileSync(file, original); }
}
function copyPrivateSourceClosure(sourceRoot: string): string {
  const parentBuild = path.join(sourceRoot, 'build/dcg-receipt-probes');
  fs.mkdirSync(parentBuild, { recursive: true });
  const privateRoot = path.join(parentBuild, `private-${crypto.randomUUID()}`);
  fs.mkdirSync(privateRoot, { recursive: false });
  for (const relative of ['compiler', 'runtime', 'sdk'])
    fs.cpSync(path.join(sourceRoot, relative), path.join(privateRoot, relative), { recursive: true, dereference: false });
  fs.mkdirSync(path.join(privateRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'scripts/build.ts'), path.join(privateRoot, 'scripts/build.ts'));
  fs.mkdirSync(path.join(privateRoot, 'tests/dcg-facts'), { recursive: true });
  for (const name of ['common.bend', 'dcg-inputs.json', 'eligible-winner.bend', 'fact-bindings.bend', 'fold-completion.bend', 'tag131.bend', 'tag132.bend', 'tag172.bend'])
    fs.copyFileSync(path.join(sourceRoot, 'tests/dcg-facts', name), path.join(privateRoot, 'tests/dcg-facts', name));
  fs.mkdirSync(path.join(privateRoot, 'tests'), { recursive: true });
  for (const name of ['dcg-facts.ts', 'dcg-facts-receipt.ts'])
    fs.copyFileSync(path.join(sourceRoot, 'tests', name), path.join(privateRoot, 'tests', name));
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(privateRoot, 'package.json'));
  fs.mkdirSync(path.join(privateRoot, '.deps'), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(sourceRoot, '.deps/bend')), path.join(privateRoot, '.deps/bend'), 'dir');
  fs.symlinkSync(fs.realpathSync(path.join(sourceRoot, 'node_modules')), path.join(privateRoot, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(privateRoot, 'build'), { recursive: true });
  return privateRoot;
}

async function mainInPrivateTree(): Promise<void> {
  assert.ok(fs.existsSync(runner), 'the actual parent DCG sizing runner is present in a private source copy');
  assert.ok(fs.existsSync(path.join(root, 'compiler/backend.ts')) && fs.existsSync(header),
    'private validation root contains the compiler/runtime source closure');
  assert.equal(fs.existsSync(path.join(root, 'tests/dcg-facts/baseline-current-snapshot')), false,
    'no frozen comparison snapshot is copied or required');
  assert.deepEqual(fs.readdirSync(path.join(root, 'scripts')).sort(), ['build.ts'],
    'the private source closure copies scripts/build.ts only, with no scripts output or caches');
  assert.equal(fs.existsSync(path.join(root, 'scripts/test-runner/target')), false,
    'the private source closure never copies the Rust test-runner target cache');
  assert.deepEqual(fs.readdirSync(path.join(root, 'tests/dcg-facts')).sort(),
    ['common.bend', 'dcg-inputs.json', 'eligible-winner.bend', 'fact-bindings.bend', 'fold-completion.bend', 'tag131.bend', 'tag132.bend', 'tag172.bend'],
    'the private source closure contains only the DCG fixture inputs');

  // A stale, ignored main-repository snapshot note must not affect acceptance.
  const inputsFile = path.join(root, 'tests/dcg-facts/dcg-inputs.json');
  const originalInputs = fs.readFileSync(inputsFile);
  const inputsDocument = JSON.parse(originalInputs.toString('utf8'));
  inputsDocument.bendSvmMain ??= {};
  inputsDocument.bendSvmMain.baselineSnapshot = {
    source: 'tests/dcg-facts/baseline-current-snapshot', copiedTo: 'missing/stale/snapshot', fileCount: -1,
  };
  fs.mkdirSync(probesDir, { recursive: true });

  const positiveBefore = existingRuns();
  const positive = await withRestoredSource(inputsFile,
    () => Buffer.from(JSON.stringify(inputsDocument, null, 2) + '\n'), async () => runSync());
  assert.equal(positive.status, 0, `actual parent positive run passed: ${positive.stderr}`);
  const positiveRunDir = newRun(positiveBefore);
  const reportBytes = fs.readFileSync(canonicalReport);
  const report = JSON.parse(reportBytes.toString('utf8'));
  assert.equal(report.status, 'complete');
  assert.equal(report.acceptance, 'complete: all three generated SBF wrapper frames measured');
  assert.equal(report.artifactRoot, path.relative(root, positiveRunDir));
  assert.equal(fs.readFileSync(path.join(positiveRunDir, 'report.json')).toString('utf8'), reportBytes.toString('utf8'));
  assert.equal(report.inputs.bendSvmExecution.sourceRoot, fs.realpathSync(root));
  assert.equal(report.inputs.bendSvmExecution.directCheckout, false,
    'a copied nested source root is not reported as the surrounding checkout');
  assert.equal(report.inputs.bendSvmExecution.headCommit, undefined, 'the surrounding Git commit is not presented as executed-source provenance');
  assert.equal(report.inputs.bendSvmExecution.dirty, undefined, 'surrounding Git dirtiness is not presented as executed-source provenance');
  for (const key of ['sourceHashesBefore', 'sourceHashesAfter']) {
    const snapshot = report.inputs.bendSvmExecution[key];
    assert.equal(snapshot.sourceRoot, fs.realpathSync(root));
    assert.equal(snapshot.directCheckout, false);
    assert.equal(snapshot.inventorySha256, inventorySha256(snapshot.files), `${key} inventory is bound to per-file hashes`);
  }
  assert.equal(report.inputs.bendSvmExecution.inventorySha256Before, report.inputs.bendSvmExecution.inventorySha256After);
  assert.deepEqual(report.inputs.bendSvmExecution.sourceHashesBefore, report.inputs.bendSvmExecution.sourceHashesAfter,
    'source, Bend, and tool hashes are unchanged across the run');
  const boundConfig = report.inputs.bendSvmExecution.sourceHashesBefore.files['config:tests/dcg-facts/dcg-inputs.json#dcg'];
  assert.equal(boundConfig, sha(JSON.stringify(JSON.parse(originalInputs.toString('utf8')).dcg)),
    'only the used DCG configuration projection is bound');
  assert.equal(report.inputs.bendSvmExecution.sourceHashesBefore.files['tests/dcg-facts/dcg-inputs.json'], undefined,
    'ignored stale snapshot metadata is not treated as an execution input');
  assert.equal(Object.keys(report.inputs.bendSvmExecution.sourceHashesBefore.files).some(name => name.includes('baseline-current-snapshot')), false);
  assert.deepEqual(report.inputs.compilerIncludeClosureAfter, report.inputs.compilerIncludeClosure,
    'the report records identical compiler include hashes before and after compilation');
  assert.deepEqual(report.inputs.generatedCompilerInputsAfter, report.inputs.generatedCompilerInputs,
    'generated compiler sources and headers are unchanged after compilation');
  assert.deepEqual(report.artifactOutputSha256Before, {}, 'the unique run artifact directory starts empty');
  assert.deepEqual(report.artifactOutputSha256After, report.artifactOutputSha256,
    'final artifacts have one authoritative after-hash map');
  assert.equal(report.trustBoundary.sbfTools.includes('not semantically verified'), true);
  assert.equal(report.trustBoundary.sbfTools.includes('does not prove a malicious native tool correct'), true);
  assert.equal(report.trustBoundary.sbfTools.includes('do not establish expected compiler identity'), true,
    'native format, version, path, and hash are not presented as expected compiler identity');
  assert.equal(report.trustBoundary.sbfTools.includes('does not prove that a file was not replaced transiently during compilation'), true,
    'separate dependency scans do not claim to detect replacement-and-restore races');
  assert.equal(report.trustBoundary.sbfTools.includes('Python used for separate refinement checks'), true,
    'Python refinement tooling remains an explicit trust assumption where used');
  assert.equal(report.inputs.compilerIncludeClosure.tag132['runtime/solana_min.h'],
    sha(fs.readFileSync(header)), 'the actual runtime include is explicitly bound');
  assert.equal(Object.keys(report.inputs.compilerIncludeClosure.tag132).length, 5,
    'Clang dependency output enumerates and hashes the generated source and transitive headers');
  assert.ok(report.inputs.compilerIncludeClosure.tag132[
    `build/dcg-facts/runs/${path.basename(positiveRunDir)}/dcg-tag-132.frame.c`],
  'Clang dependency output binds the exact generated translation unit');
  assert.equal(Object.keys(report.inputs.generatedCompilerInputs.tag132).some(name => name.includes('manifest.json')), false,
    'the report does not advertise an unchecked manifest');
  const expected = new Map([[132, [675, 676, 860, 138, 180, 821]], [131, [879, 880, 1092, 335, 452, 1222]], [172, [954, 955, 1136, 340, 456, 1302]]]);
  for (const handler of report.handlers) {
    const [factWire, factRequest, factNative, planWire, planNative, nativeCases] = expected.get(handler.tag)!;
    assert.deepEqual([handler.facts.wireBytes, handler.facts.requestBytes, handler.facts.nativeBytes,
      handler.plan.wireBytes, handler.plan.nativeBytes], [factWire, factRequest, factNative, planWire, planNative]);
    assert.equal(handler.compiledFrame.status, 'measured');
    assert.ok(handler.compiledFrame.bytes > 0 && handler.compiledFrame.bytes <= 4096);
    assert.ok(handler.compiledFrame.entrypointBytes > 0 && handler.compiledFrame.entrypointBytes <= handler.compiledFrame.bytes);
    const relativeFrame = path.join(report.artifactRoot, `dcg-tag-${handler.tag}.frame.c`);
    assert.equal(handler.compiledFrame.source, relativeFrame, 'stack usage is tied to this run’s correct generated frame source');
    assert.equal(handler.compiledFrame.sourceSha256, report.inputs.generatedCompilerInputsAfter[`tag${handler.tag}`][relativeFrame]);
    const entrypoint = handler.compiledFrame.functions.find((fn: any) => fn.location === `dcg-tag-${handler.tag}.frame.c:4:entrypoint`);
    assert.equal(entrypoint.bytes, handler.compiledFrame.entrypointBytes);
    assertExactRawEntrypointLocation(report, handler);
    assert.equal(handler.nativeCases, nativeCases, `tag ${handler.tag} keeps positive codec/sizing cases`);
  }
  for (const [relative, digest] of Object.entries(report.artifactOutputSha256 as Record<string, string>)) {
    assert.ok(relative.startsWith(path.relative(root, positiveRunDir) + path.sep), `success artifacts are fresh: ${relative}`);
    assert.equal(sha(fs.readFileSync(path.join(root, relative))), digest, `success artifact digest ${relative}`);
  }
  for (const tool of Object.values(report.inputs.buildTools.sbf) as any[]) {
    assert.ok(tool.sha256 && /^[a-f0-9]{64}$/.test(tool.sha256), 'trusted SBF binary hash is recorded');
    assert.ok(tool.binaryFormat, 'a native binary format was checked before invocation');
  }
  const ld = report.inputs.buildTools.sbf['ld.lld'];
  assert.equal(path.basename(ld.invokedAs), 'ld.lld', 'the Anza ld.lld entrypoint alias remains supported');
  assert.equal(ld.path, fs.realpathSync(ld.invokedAs), 'the alias resolves to the recorded native linker binary');

  const archivePath = path.join(canonicalDir, 'archive');
  const archiveSaved = path.join(probesDir, `saved-archive-${crypto.randomUUID()}`);
  let archiveWasPresent = false;
  if (fs.existsSync(archivePath)) {
    fs.renameSync(archivePath, archiveSaved);
    archiveWasPresent = true;
  }
  const canonicalBeforeConflict = fs.readFileSync(canonicalReport);
  try {
    fs.writeFileSync(archivePath, 'archive path conflict\n');
    const before = existingRuns();
    const conflict = runSync();
    assert.equal(conflict.status, 1, 'archive conflict fails the parent before new sizing work');
    failureReceipt(newRun(before), 'DCG-ARCHIVE-CONFLICT', `${conflict.stdout}\n${conflict.stderr}`);
    assert.deepEqual(fs.readFileSync(canonicalReport), canonicalBeforeConflict,
      'archive failure preserves the exact previous canonical success bytes');
  } finally {
    fs.rmSync(archivePath, { force: true });
    if (archiveWasPresent) fs.renameSync(archiveSaved, archivePath);
  }

  const realTools = Object.fromEntries(['clang', 'ld.lld', 'llvm-readelf'].map(name =>
    [name, report.inputs.buildTools.sbf[name].path]));
  const wrapperProbe = path.join(probesDir, `sbf-wrapper-${crypto.randomUUID()}`);
  const wrapperMarker = path.join(wrapperProbe, 'executed');
  fs.mkdirSync(wrapperProbe, { recursive: true });
  const wrapper = `#!/bin/sh\n: > ${shellQuote(wrapperMarker)}\nexec ${shellQuote(realTools.clang)} "$@"\n`;
  const wrapperTools = path.join(wrapperProbe, 'tools');
  createSbfTools(wrapperTools, realTools, wrapper);
  const wrapperBefore = existingRuns();
  const substituted = runSync({ SBF_TOOLS: wrapperTools });
  assert.equal(substituted.status, 1, 'a compiler script wrapper is rejected before it can produce sizing evidence');
  failureReceipt(newRun(wrapperBefore), 'DCG-SBF-TOOL-UNUSABLE', `${substituted.stdout}\n${substituted.stderr}`);
  assert.equal(fs.existsSync(wrapperMarker), false, 'non-native SBF compiler wrapper was never invoked');

  const zeroProbe = path.join(probesDir, `native-zero-${crypto.randomUUID()}`);
  const zeroTools = path.join(zeroProbe, 'tools');
  fs.mkdirSync(zeroTools, { recursive: true });
  const zeroWrapper = compileNativeZeroWrapper(zeroProbe);
  fs.copyFileSync(zeroWrapper, path.join(zeroTools, 'clang'));
  fs.chmodSync(path.join(zeroTools, 'clang'), 0o700);
  fs.symlinkSync(realTools['ld.lld'], path.join(zeroTools, 'ld.lld'));
  fs.symlinkSync(realTools['llvm-readelf'], path.join(zeroTools, 'llvm-readelf'));
  const zeroBefore = existingRuns();
  const zeroFrame = runSync({ SBF_TOOLS: zeroTools, DCG_REAL_CLANG: realTools.clang, DCG_ZERO_STUB_DIR: zeroProbe });
  assert.equal(zeroFrame.status, 1, 'a native compiler wrapper substituting a zero-frame entrypoint fails the actual parent');
  const zeroRunDir = newRun(zeroBefore);
  const zeroReceipt = failureReceipt(zeroRunDir, 'DCG-SBF-STACK-USAGE', `${zeroFrame.stdout}\n${zeroFrame.stderr}`);
  for (const tag of [132, 131, 172]) {
    const raw = fs.readFileSync(path.join(root, zeroReceipt.artifactRoot, `dcg-tag-${tag}.frame.su`), 'utf8');
    assert.match(raw, new RegExp(`build/dcg-facts/runs/${path.basename(zeroReceipt.artifactRoot)}/dcg-tag-${tag}\\.frame\\.c:4:entrypoint\\t0\\tstatic`),
      'the native substitute reached the nonzero stack-usage guard with the expected source path and a zero-frame entrypoint');
  }

  const wrongPathProbe = path.join(probesDir, `native-wrong-stack-path-${crypto.randomUUID()}`);
  const wrongPathTools = path.join(wrongPathProbe, 'tools');
  fs.mkdirSync(wrongPathTools, { recursive: true });
  fs.copyFileSync(zeroWrapper, path.join(wrongPathTools, 'clang'));
  fs.chmodSync(path.join(wrongPathTools, 'clang'), 0o700);
  fs.symlinkSync(realTools['ld.lld'], path.join(wrongPathTools, 'ld.lld'));
  fs.symlinkSync(realTools['llvm-readelf'], path.join(wrongPathTools, 'llvm-readelf'));
  const wrongPathEnv = { SBF_TOOLS: wrongPathTools, DCG_REAL_CLANG: realTools.clang,
    DCG_FRAME_STUB_DIR: wrongPathProbe, DCG_FRAME_STUB_MODE: 'wrong-path' };
  const wrongPathBefore = existingRuns();
  const wrongPath = runSync(wrongPathEnv);
  assert.equal(wrongPath.status, 1, 'a native compiler substitute with a nonzero frame and wrong raw .su directory fails the parent');
  const wrongPathReceipt = failureReceipt(newRun(wrongPathBefore), 'DCG-SBF-STACK-USAGE',
    `${wrongPath.stdout}\n${wrongPath.stderr}`);
  const wrongRaw = fs.readFileSync(path.join(root, wrongPathReceipt.artifactRoot, 'dcg-tag-132.frame.su'), 'utf8');
  const wrongEntrypoint = wrongRaw.trim().split(/\r?\n/).map(line => line.split('\t', 3))
    .find(([location]) => location?.endsWith(':entrypoint'));
  assert.ok(wrongEntrypoint, 'native nonzero substitute emitted a raw entrypoint stack record');
  assert.match(wrongEntrypoint[0], /^wrong-directory\/dcg-tag-132\.frame\.c:4:entrypoint$/,
    'the native substitute emitted the right basename and line in the wrong raw source directory');
  assert.ok(Number(wrongEntrypoint[1]) > 0, 'the wrong-directory native substitute has a nonzero frame');

  const exactRawPathCheck = 'rawEntrypoints[0][0] !== expectedRawEntrypoint || ';
  const withoutRawPathGate = await withRestoredSource(runner, original => Buffer.from(replaceExactlyOnce(
    original.toString('utf8'), exactRawPathCheck, ''), 'utf8'), async () => runSync(wrongPathEnv));
  assert.equal(withoutRawPathGate.status, 0, 'deleting the parent raw .su path check lets the nonzero wrong-directory substitute through');
  const mutantReport = JSON.parse(fs.readFileSync(path.join(withoutRawPathGate.runDir, 'report.json'), 'utf8'));
  assert.equal(mutantReport.status, 'complete');
  const mutantHandler = mutantReport.handlers.find((handler: any) => handler.tag === 132);
  assert.throws(() => assertExactRawEntrypointLocation(mutantReport, mutantHandler),
    /raw Clang \.su must preserve the exact generated frame path/,
    'the receipt verifier itself rejects the successful report produced after removing the exact-path gate');

  const compilerInvocation = path.join(path.dirname(realTools.clang), 'clang');
  const missingHeaderSource = path.join(probesDir, `missing-include-${crypto.randomUUID()}.c`);
  fs.writeFileSync(missingHeaderSource, '#include "dcg-probe-missing.h"\nint main(void) { return 0; }\n');
  try {
    const missingHeaderCompile = spawnSync(compilerInvocation, ['-fsyntax-only', missingHeaderSource], { encoding: 'utf8' });
    assert.ok(!missingHeaderCompile.error, 'the native compiler itself started for the missing-header probe');
    assert.notEqual(missingHeaderCompile.status, 0, 'the real compiler rejects the missing include');
    assert.match(missingHeaderCompile.stderr, /fatal error:.*file not found/);
    const missingHeaderText = `${compilerInvocation} failed (${missingHeaderCompile.status}): ${missingHeaderCompile.stderr}`;
    assert.equal(receiptError(new Error(missingHeaderText)).code, 'DCG-COMPILE-ERROR',
      'actual missing-include compiler stderr is not classified as a missing tool');
  } finally {
    fs.rmSync(missingHeaderSource, { force: true });
  }
  assert.equal(receiptError(new Error(`${path.join(probesDir, 'missing-host-compiler')} failed (undefined): Error: ENOENT: no such file or directory, posix_spawn '/missing-host-compiler'`)).code,
    'DCG-RUNNER-ERROR', 'serialized ENOENT text without structured spawn evidence is not classified as a missing tool');
  const filesystemError = Object.assign(new Error("ENOENT: no such file or directory, stat 'missing-source.c'"), {
    code: 'ENOENT', syscall: 'stat',
  });
  assert.equal(receiptError(filesystemError).code, 'DCG-RUNNER-ERROR', 'filesystem ENOENT is not classified as a missing tool');
  const spawnError = Object.assign(new Error('spawnSync /missing/compiler ENOENT'), {
    code: 'ENOENT', syscall: 'spawnSync /missing/compiler',
  });
  assert.equal(receiptError(spawnError).code, 'DCG-TOOL-MISSING', 'Node spawn syscall ENOENT is process-start evidence');
  const compileBefore = existingRuns();
  const compileError = await withRestoredSource(header, original => Buffer.concat([original,
    Buffer.from('\n#error DCG missing include file not found compile probe\n')]), async () => runSync());
  assert.equal(compileError.status, 1, 'a real runtime source compile-error mutation fails the parent gate');
  failureReceipt(newRun(compileBefore), 'DCG-COMPILE-ERROR', `${compileError.stdout}\n${compileError.stderr}`);
  assert.equal(fs.existsSync(canonicalReport), false, 'a compile-error invocation publishes no canonical success');

  const spawnTextSource = path.join(probesDir, `error-spawn-text-${crypto.randomUUID()}.c`);
  fs.writeFileSync(spawnTextSource, '#error spawn helper ENOENT\n');
  try {
    const spawnTextCompile = spawnSync(compilerInvocation, ['-fsyntax-only', spawnTextSource], { encoding: 'utf8' });
    assert.ok(!spawnTextCompile.error, 'the compiler process started for the spawn-like diagnostic probe');
    assert.notEqual(spawnTextCompile.status, 0, 'the compiler rejects the #error probe');
    assert.equal(receiptError(new Error(`${compilerInvocation} failed (${spawnTextCompile.status}): ${spawnTextCompile.stderr}`)).code,
      'DCG-COMPILE-ERROR', 'compiler stderr mentioning spawn helper ENOENT is not process-start evidence');
  } finally {
    fs.rmSync(spawnTextSource, { force: true });
  }

  const missingSourceBefore = existingRuns();
  const missingSourceRun = await withMissingSource(path.join(root, 'tests/dcg-facts/tag172.bend'), async () => runSync());
  assert.equal(missingSourceRun.status, 1, 'the actual parent fails when an input source file is absent');
  const missingSourceReceipt = failureReceipt(newRun(missingSourceBefore), 'DCG-RUNNER-ERROR',
    `${missingSourceRun.stdout}\n${missingSourceRun.stderr}`);
  assert.match(missingSourceReceipt.error, /ENOENT/);
  assert.match(missingSourceReceipt.error, /stat|open/);

  const frameProbeBefore = existingRuns();
  const frameOverflow = await withRestoredSource(runner, original => Buffer.from(replaceExactlyOnce(
    original.toString('utf8'), '  return written;\n}',
    '  volatile u8 dcg_stack_bomb[5000];\n  for (unsigned i = 0; i < sizeof(dcg_stack_bomb); ++i) dcg_stack_bomb[i] = (u8)i;\n  (void)dcg_stack_bomb[sizeof(dcg_stack_bomb) - 1];\n  return written;\n}',
  )), async () => runSync());
  assert.equal(frameOverflow.status, 1, 'a real generated-frame source overflow mutation fails the parent gate');
  failureReceipt(newRun(frameProbeBefore), 'DCG-SBF-FRAME-OVERFLOW', `${frameOverflow.stdout}\n${frameOverflow.stderr}`);
  assert.equal(fs.existsSync(canonicalReport), false, 'a frame-overflow invocation publishes no canonical success');

  for (const directive of ['include_next <dcg-probe-next.h>', 'import "dcg-probe-import.h"']) {
    const before = existingRuns();
    const rejected = await withRestoredSource(header, original => Buffer.concat([original, Buffer.from(`\n#${directive}\n`)]), async () => runSync());
    const name = directive.includes('dcg-probe-next') ? 'dcg-probe-next.h' : 'dcg-probe-import.h';
    assert.equal(rejected.status, 1, `Clang rejects #${directive.split(/[ <"]/)[0]} because ${name} is absent`);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*file not found`),
      `the #${directive.split(/[ <"]/)[0]} probe fails on Clang's missing-target diagnostic`);
    failureReceipt(newRun(before), 'DCG-COMPILE-ERROR', `${rejected.stdout}\n${rejected.stderr}`);
  }

  const hiddenHeader = path.join(probesDir, 'hidden # $ header.h');
  const hiddenHeaderKey = path.relative(root, hiddenHeader).split(path.sep).join('/');
  const hiddenHeaderRelative = path.relative(path.join(root, 'runtime'), hiddenHeader).split(path.sep).join('/');
  const hiddenHeaderBytes = Buffer.from('#define DCG_HIDDEN_DEPENDENCY_PROBE 1\n');
  fs.writeFileSync(hiddenHeader, hiddenHeaderBytes);
  for (const directive of [
    `/**/#include "${hiddenHeaderRelative}"`,
    `%:include "${hiddenHeaderRelative}"`,
    `#\\\ninclude "${hiddenHeaderRelative}"`,
  ]) {
    const before = existingRuns();
    const hidden = await withRestoredSource(header, original => Buffer.concat([original, Buffer.from(`\n${directive}\n`)]), async () => runSync());
    assert.equal(hidden.status, 0, `Clang dependency closure accepts actual preprocessor spelling: ${directive}`);
    const runDir = newRun(before);
    const hiddenReport = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
    for (const tag of [132, 131, 172]) {
      assert.equal(hiddenReport.inputs.compilerIncludeClosure[`tag${tag}`][hiddenHeaderKey], sha(hiddenHeaderBytes),
        `tag ${tag} hashes the transitive header reached by ${directive}`);
      assert.deepEqual(hiddenReport.inputs.compilerIncludeClosureAfter[`tag${tag}`], hiddenReport.inputs.compilerIncludeClosure[`tag${tag}`],
        `tag ${tag} rechecks the same dependency closure after compilation`);
    }
  }

  const backslashDirectory = path.join(probesDir, `backslash-identity-${crypto.randomUUID()}`);
  const realBackslashHeader = path.join(backslashDirectory, 'back\\sl.h');
  const slashDecoyHeader = path.join(backslashDirectory, 'back/sl.h');
  const realBackslashBytes = Buffer.from('#define DCG_BACKSLASH_HEADER_IDENTITY 81\n');
  const slashDecoyBytes = Buffer.from('#error DCG slash decoy must not be compiled\n');
  fs.mkdirSync(path.dirname(realBackslashHeader), { recursive: true });
  fs.mkdirSync(path.dirname(slashDecoyHeader), { recursive: true });
  fs.writeFileSync(realBackslashHeader, realBackslashBytes);
  fs.writeFileSync(slashDecoyHeader, slashDecoyBytes);
  assert.notDeepEqual(realBackslashBytes, slashDecoyBytes, 'the real backslash header and slash decoy have distinct bytes');
  const realBackslashKey = path.relative(root, realBackslashHeader).split(path.sep).join('/');
  const slashDecoyKey = path.relative(root, slashDecoyHeader).split(path.sep).join('/');
  const backslashInclude = path.relative(path.dirname(header), realBackslashHeader).split(path.sep).join('/');
  const includeBackslashHeader = (original: Buffer) => Buffer.concat([original,
    Buffer.from(`\n#include "${backslashInclude}"\n`)]);

  const noIdentityCheck = '  assertCompilerIncludeIdentity(source, clang, dependencies.stdout ?? \'\');\n';
  const legacyBefore = existingRuns();
  const legacyBackslash = await withRestoredSource(runner, original => Buffer.from(replaceExactlyOnce(
    original.toString('utf8'), noIdentityCheck, ''), 'utf8'), async () =>
    withRestoredSource(header, includeBackslashHeader, async () => runSync()));
  assert.equal(legacyBackslash.status, 0,
    'the pre-fix dependency parser accepts a real backslash header when a slash decoy exists');
  const legacyReport = JSON.parse(fs.readFileSync(path.join(newRun(legacyBefore), 'report.json'), 'utf8'));
  assert.equal(legacyReport.status, 'complete');
  assert.equal(legacyReport.inputs.compilerIncludeClosure.tag132[slashDecoyKey], sha(slashDecoyBytes),
    'the pre-fix complete receipt hashes the slash decoy');
  assert.equal(legacyReport.inputs.compilerIncludeClosure.tag132[realBackslashKey], undefined,
    'the pre-fix complete receipt omits the real header that Clang compiled');
  const legacyCanonical = fs.readFileSync(canonicalReport);
  const backslashArchiveDir = path.join(canonicalDir, 'archive');
  const archiveNamesBeforeBackslashCheck = new Set(fs.readdirSync(backslashArchiveDir));

  const correctedBefore = existingRuns();
  const correctedBackslash = await withRestoredSource(header, includeBackslashHeader, async () => runSync());
  assert.equal(correctedBackslash.status, 1, 'the corrected parent rejects a compiled header name containing backslash');
  const correctedRunDir = newRun(correctedBefore);
  const correctedReceipt = failureReceipt(correctedRunDir, 'DCG-INCLUDE-CLOSURE',
    `${correctedBackslash.stdout}\n${correctedBackslash.stderr}`);
  assert.match(correctedReceipt.error, /backslash/,
    'the corrected parent reports the unsupported real header name, not a missing decoy or compiler failure');
  assert.equal(fs.existsSync(canonicalReport), false, 'the backslash identity failure publishes no canonical success');
  const newArchiveNames = fs.readdirSync(backslashArchiveDir).filter(name => !archiveNamesBeforeBackslashCheck.has(name));
  assert.equal(newArchiveNames.length, 1, 'the prior successful receipt is archived before the closed failure');
  assert.deepEqual(fs.readFileSync(path.join(backslashArchiveDir, newArchiveNames[0])), legacyCanonical,
    'the prior complete receipt bytes are preserved in the archive');

  const publishFailureBefore = existingRuns();
  assert.equal(fs.existsSync(path.join(root, 'tests/dcg-facts/sizing-report.json')), false,
    'private source report path starts empty for --record-report ordering check');
  const failedPublication = await withRestoredSource(runner, original => Buffer.from(replaceExactlyOnce(
    original.toString('utf8'), 'fs.linkSync(temp, file);',
    "throw Object.assign(new Error('injected canonical publication failure'), { code: 'EIO' });",
  )), async () => runSync({}, ['--record-report']));
  assert.equal(failedPublication.status, 1, 'injected canonical report publication failure fails the parent');
  const publicationReceipt = failureReceipt(newRun(publishFailureBefore), 'DCG-PUBLISH-FAILED',
    `${failedPublication.stdout}\n${failedPublication.stderr}`);
  assert.equal(publicationReceipt.successReportPublished, false);
  assert.equal(fs.existsSync(canonicalReport), false, 'failed canonical publication leaves no canonical success');
  assert.equal(fs.existsSync(path.join(root, 'tests/dcg-facts/sizing-report.json')), false,
    '--record-report cannot publish a current-looking source report before canonical publication');

  const sourceDrift = await runAtCompilerGate('source');
  await runAtCompilerGate('tool');

  const missingToolsBefore = existingRuns();
  const missingToolsPath = path.join(probesDir, 'missing-sbf-tools');
  fs.rmSync(missingToolsPath, { recursive: true, force: true });
  const missing = runSync({ SBF_TOOLS: missingToolsPath });
  assert.equal(missing.status, 1, 'wrong SBF_TOOLS fails the actual parent runner');
  failureReceipt(newRun(missingToolsBefore), 'DCG-SBF-TOOL-MISSING', `${missing.stdout}\n${missing.stderr}`);

  const missingHostBefore = existingRuns();
  const missingHost = runSync({ CC: path.join(probesDir, 'missing-host-compiler') });
  assert.equal(missingHost.status, 1, 'a host compiler spawn failure fails the actual parent runner');
  failureReceipt(newRun(missingHostBefore), 'DCG-TOOL-MISSING', `${missingHost.stdout}\n${missingHost.stderr}`);

  const shadowPath = path.join(root, 'build/solana_min.h');
  assert.equal(fs.existsSync(shadowPath), false, 'private test copy did not inherit a build-root header shadow');
  fs.writeFileSync(shadowPath, '#error forbidden build-root shadow\n');
  try {
    const shadowBefore = existingRuns();
    const shadow = runSync();
    assert.equal(shadow.status, 1, 'actual parent rejects the build-root header guard path');
    failureReceipt(newRun(shadowBefore), 'DCG-INCLUDE-SHADOW', `${shadow.stdout}\n${shadow.stderr}`);
  } finally {
    fs.rmSync(shadowPath, { force: true });
  }

  assert.equal(fs.existsSync(canonicalReport), false, 'no failed invocation left a canonical success report');
  assert.deepEqual(fs.readFileSync(header), fs.readFileSync(path.join(invokedRoot, 'runtime/solana_min.h')),
    'all runtime header source mutations were restored in the private tree');
  assert.equal(fs.existsSync(path.join(root, 'tests/dcg-facts/sizing-report.json')), false,
    'no interrupted report-publication probe left a success-looking source report');
  console.log(`DCG receipt integrity passed in private tree ${root}: source-bound positive sizing; Clang dependency/include-trace identity closure including comment/digraph/spliced includes and backslash-name rejection; native SBF tool gate, ld.lld alias, zero-frame rejection, and wrong raw .su path mutation; missing-source vs process-start ENOENT classification; source compile-error and frame-overflow mutations; missing include_next/import targets; --record-report publication ordering; archive conflict; source/tool drift (${sourceDrift.runDir}); missing tools; shadow guard`);
}

async function main(): Promise<void> {
  const privateRoot = copyPrivateSourceClosure(invokedRoot);
  process.chdir(privateRoot);
  root = fs.realpathSync(privateRoot);
  runner = path.join(root, 'tests/dcg-facts.ts');
  canonicalDir = path.join(root, 'build/dcg-facts');
  canonicalReport = path.join(canonicalDir, 'report.json');
  runsDir = path.join(canonicalDir, 'runs');
  probesDir = path.join(root, 'build/dcg-receipt-probes');
  header = path.join(root, 'runtime/solana_min.h');
  try { await mainInPrivateTree(); }
  finally { process.chdir(invokedRoot); }
}

if (import.meta.main) await main();
