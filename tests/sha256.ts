import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256, SHA256_MAX_BYTES, SHA256_MAX_SLICES} from '../sdk/sha256.ts';

type PartSpec =
  | {kind: 'hex'; hex: string}
  | {kind: 'repeat'; byte: number; length: number}
  | {kind: 'ramp'; length: number};
type Vector = {name: string; parts: PartSpec[]; expected: string};

const fail = (message: string): never => { throw new Error(`SHA-256 validation: ${message}`); };
function command(file: string, args: string[], capture = false, env = process.env): string {
  const result = spawnSync(file, args, {encoding: 'utf8', env,
    stdio: capture ? 'pipe' : 'inherit', timeout: 600_000, maxBuffer: 16 << 20});
  if (result.error || result.status !== 0)
    fail(`${file} ${args.join(' ')} failed (${result.status}): ${result.error ?? result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}
function toolPath(file: string): string {
  if (file.includes(path.sep)) return path.resolve(file);
  const resolved = command('which', [file], true);
  if (!resolved) fail(`cannot resolve tool ${file}`);
  return fs.realpathSync(resolved);
}
function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function bytes(spec: PartSpec): Uint8Array {
  if (spec.kind === 'hex') return Buffer.from(spec.hex, 'hex');
  if (spec.kind === 'repeat') return new Uint8Array(spec.length).fill(spec.byte);
  return Uint8Array.from({length: spec.length}, (_, index) => index & 0xff);
}
function reference(parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}
function encodeInstruction(parts: readonly Uint8Array[]): Buffer {
  const encoded: Buffer[] = [Buffer.from([parts.length])];
  for (const part of parts) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(part.byteLength);
    encoded.push(length, Buffer.from(part));
  }
  return Buffer.concat(encoded);
}
function checkOffchain(vectors: Vector[]): void {
  assert.deepEqual(vectors.map(vector => vector.name), [
    'empty', 'empty-slice', 'abc', 'abc-multipart', 'padding-55', 'padding-56',
    'padding-63', 'padding-64', 'padding-65', 'padding-127', 'padding-128',
    'padding-129', 'sixteen-slices', 'maxbytes-ramp', 'maxbytes-sixteen-parts',
  ], 'complete required vector set');
  assert.equal(SHA256_MAX_SLICES, 16);
  assert.equal(SHA256_MAX_BYTES, 1024);
  for (const vector of vectors) {
    const parts = vector.parts.map(bytes);
    const snapshots = parts.map(part => Buffer.from(part));
    const result = sha256(parts);
    assert.equal(result.ok, true, vector.name);
    if (!result.ok) fail(`${vector.name}: ${result.error}`);
    assert.equal(Buffer.from(result.digest).toString('hex'), vector.expected, vector.name);
    assert.equal(reference(parts), vector.expected, `node:crypto reference: ${vector.name}`);
    parts.forEach((part, index) => assert.deepEqual(Buffer.from(part), snapshots[index], `immutable input: ${vector.name}`));
    const flat = Buffer.concat(parts.map(part => Buffer.from(part)));
    const concatenated = sha256([flat]);
    assert.equal(concatenated.ok, true, `concatenation: ${vector.name}`);
    if (!concatenated.ok) fail(`${vector.name}: concatenation ${concatenated.error}`);
    assert.deepEqual(concatenated.digest, result.digest, `multipart equivalence: ${vector.name}`);
  }
  assert.equal(sha256(new Array(17).fill(new Uint8Array())).ok, false);
  assert.deepEqual(sha256(new Array(17).fill(new Uint8Array())),
    {ok: false, error: 'too-many-slices'});
  assert.deepEqual(sha256([new Uint8Array(1024), new Uint8Array(1)]),
    {ok: false, error: 'too-many-bytes'});
  assert.deepEqual(sha256([null as unknown as Uint8Array]),
    {ok: false, error: 'invalid-arguments'});
  const brokenArray = new Proxy([], {get(target, key, receiver) {
    if (key === 'length') throw new Error('unreadable input array');
    return Reflect.get(target, key, receiver);
  }});
  assert.deepEqual(sha256(brokenArray as unknown as Uint8Array[]),
    {ok: false, error: 'invalid-arguments'});
  if (typeof SharedArrayBuffer !== 'undefined') {
    assert.deepEqual(sha256([new Uint8Array(new SharedArrayBuffer(1))]),
      {ok: false, error: 'invalid-arguments'});
  }
  for (const length of [0, 3]) {
    const detached = new Uint8Array(length);
    structuredClone(detached.buffer, {transfer:[detached.buffer]});
    assert.deepEqual(sha256([detached]), {ok:false,error:'invalid-arguments'}, 'detached view rejected');
  }
  const resizable = new ArrayBuffer(8, {maxByteLength:16});
  const outOfBounds = new Uint8Array(resizable,4,4);
  resizable.resize(2);
  assert.deepEqual(sha256([outOfBounds]), {ok:false,error:'invalid-arguments'}, 'out-of-bounds resized view');
  const validEmpty = new Uint8Array(resizable,2,0);
  assert.equal(sha256([validEmpty]).ok,true,'valid empty resized view');
  const tracking = new Uint8Array(resizable);
  tracking[0]=97;tracking[1]=98;
  const trackingResult=sha256([tracking]);assert(trackingResult.ok);
  assert.equal(Buffer.from(trackingResult.digest).toString('hex'),reference([Buffer.from('ab')]),'valid length-tracking view');
  const spoofedLength = new Uint8Array(1025);
  Object.defineProperty(spoofedLength, 'byteLength', {get: () => 0});
  assert.deepEqual(sha256([spoofedLength]), {ok:false,error:'too-many-bytes'}, 'intrinsic byte bound');
  const sixteen = sha256(Array.from({length: 16}, () => new Uint8Array(64)));
  assert.equal(sixteen.ok, true, 'exact slice and byte limits are accepted');
}

function compileNative(outFile: string, compiler: string): string {
  const version = command(compiler, ['--version'], true);
  command(compiler, ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
    '-fno-omit-frame-pointer', '-fsanitize=address,undefined', '-Iruntime',
    'tests/sha256/native.c', '-o', outFile]);
  const binaryHash = hashFile(outFile);
  const output = command(outFile, [], true, {...process.env, ASAN_OPTIONS: 'halt_on_error=1',
    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1'});
  assert.match(output, /native SHA-256 ABI wrapper checks passed/);
  assert.equal(hashFile(outFile), binaryHash, 'native executable changed during test');
  return version;
}

function compileSbf(runDir: string, toolsDir: string): {
  clang: string; linker: string; readelf: string; clangVersion: string; linkerVersion: string;
  readelfVersion: string; frameBytes: number; imports: string[];
} {
  const clang = path.join(toolsDir, 'clang');
  const linker = path.join(toolsDir, 'ld.lld');
  const readelf = path.join(toolsDir, 'llvm-readelf');
  for (const binary of [clang, linker, readelf]) if (!fs.existsSync(binary)) fail(`missing pinned SBF tool ${binary}`);
  const clangVersion = command(clang, ['--version'], true);
  if (!clangVersion.includes('20.1.7') || !clangVersion.includes('anza-xyz'))
    fail('expected Anza platform-tools v1.53 Clang 20.1.7');
  const linkerVersion = command(linker, ['--version'], true);
  const readelfVersion = command(readelf, ['--version'], true);
  const object = path.join(runDir, 'sha256.o');
  const memoryObject = path.join(runDir, 'sha256.memory.o');
  const usageFiles = [path.join(runDir, 'sha256.su'), path.join(runDir, 'sha256.memory.su')];
  const flags = ['--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding',
    '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections', '-fdata-sections',
    '-Iruntime'];
  command(clang, [...flags, '-c', 'tests/sha256/sbf.c', '-o', object], true);
  command(clang, [...flags, '-c', 'runtime/memory.c', '-o', memoryObject], true);
  if (usageFiles.some(file => !fs.existsSync(file))) fail('Clang did not emit every required SBF stack report');
  const so = path.join(runDir, 'sha256.so');
  command(linker, ['-z', 'notext', '-shared', '--Bdynamic', 'runtime/sbf.ld',
    '--entry', 'entrypoint', '-z', 'max-page-size=4096', '--gc-sections', object, memoryObject,
    '-o', so], true);
  const symbols = command(readelf, ['-s', so], true);
  const imports = [...new Set(symbols.split('\n').filter(line => /\bUND\b/.test(line))
    .map(line => line.trim().split(/\s+/).at(-1)!).filter(symbol => symbol !== 'UND'))];
  const expectedImports = ['sol_memset_', 'sol_set_return_data', 'sol_sha256'];
  assert.deepEqual([...imports].sort(), expectedImports, 'SBF syscall import allowlist');
  const frames = usageFiles.flatMap(usage => fs.readFileSync(usage, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => {
      const [location, frameBytes] = line.split('\t');
      if (!location || !/^\d+$/.test(frameBytes ?? '')) fail(`invalid stack report row: ${line}`);
      return Number(frameBytes);
    }));
  const frameBytes = Math.max(0, ...frames);
  if (frameBytes >= 4096) fail(`SBF frame exceeds 4,096 bytes: ${frameBytes}`);
  return {clang, linker, readelf, clangVersion, linkerVersion, readelfVersion, frameBytes, imports};
}

async function main(): Promise<void> {
  const runDir = path.resolve('build/sha256', `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  fs.mkdirSync(path.dirname(runDir), {recursive:true});
  fs.mkdirSync(runDir, {recursive: false});
  const inputFiles = [
    'runtime/bend_sha256.h', 'runtime/solana_min.h', 'runtime/sbf.ld', 'runtime/memory.c', 'sdk/sha256.ts',
    'tests/sha256.ts', 'tests/sha256_sbf.rs', 'tests/sha256/Cargo.toml',
    'tests/sha256/Cargo.lock', 'tests/sha256/native.c', 'tests/sha256/sbf.c',
    'tests/sha256/vectors.json', 'docs/sha256.md',
  ];
  const inputHashes = Object.fromEntries(inputFiles.map(file => [file,hashFile(file)]));
  const vectors = JSON.parse(fs.readFileSync('tests/sha256/vectors.json', 'utf8')) as Vector[];
  checkOffchain(vectors);

  const nativeCompiler = process.env.CC ?? 'clang';

  const privateTools = path.resolve('build/sha256/platform-tools/llvm/bin');
  const defaultTools = fs.existsSync(path.join(privateTools, 'clang'))
    ? privateTools : path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin');
  const toolsDir = path.resolve(process.env.SBF_TOOLS ?? defaultTools);
  const selectedCargo = command('rustup', ['which', '--toolchain', '1.92.0', 'cargo'], true);
  const selectedRustc = command('rustup', ['which', '--toolchain', '1.92.0', 'rustc'], true);
  const nativeResolved = toolPath(nativeCompiler);
  const actualNative = process.platform === 'darwin' && nativeResolved === '/usr/bin/clang'
    ? command('xcrun', ['--find', 'clang'], true) : nativeResolved;
  const tools = [nativeCompiler, actualNative, path.join(toolsDir,'clang'), path.join(toolsDir,'ld.lld'),
    path.join(toolsDir,'llvm-readelf'), 'cargo', 'rustc', 'rustup', 'which', selectedCargo, selectedRustc, process.execPath];
  const toolHashes = Object.fromEntries([...new Set(tools)].map(tool => {
    const resolved = toolPath(tool);
    return [tool, {path: resolved, sha256: hashFile(resolved)}];
  }));
  const nativeVersion = compileNative(path.join(runDir, 'sha256-native'), nativeCompiler);
  const sbf = compileSbf(runDir, toolsDir);
  const compiledFiles = ['sha256-native', 'sha256.o', 'sha256.memory.o', 'sha256.su', 'sha256.memory.su', 'sha256.so'];
  const compiledHashes = Object.fromEntries(compiledFiles.map(file => [file,hashFile(path.join(runDir,file))]));
  const cargoVersion = command('cargo', ['+1.92.0', '--version'], true);
  const rustcVersion = command('rustc', ['+1.92.0', '--version'], true);
  const metricsPath = path.join(runDir, 'sbf-metrics.json');
  const cargoArtifacts = command('cargo', ['+1.92.0', 'test', '--locked', '--no-run',
    '--message-format=json', '--manifest-path', 'tests/sha256/Cargo.toml',
    '--target-dir', 'target/sha256'], true);
  fs.writeFileSync(path.join(runDir,'cargo-artifacts.jsonl'), cargoArtifacts + '\n');
  const testArtifacts = cargoArtifacts.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.reason === 'compiler-artifact' && row.profile?.test &&
      row.target?.name === 'sha256_sbf' && typeof row.executable === 'string').map(row => row.executable as string);
  assert.equal(testArtifacts.length, 1, 'Cargo must identify exactly one current test executable');
  const testBinaryHash = hashFile(testArtifacts[0]);
  command(testArtifacts[0], ['--nocapture'], false, {...process.env,
    SHA256_TEST_ELF: path.join(runDir, 'sha256.so'),
    SHA256_VECTORS: path.resolve('tests/sha256/vectors.json'), SHA256_METRICS: metricsPath});
  assert.equal(hashFile(testArtifacts[0]), testBinaryHash, 'executed test binary changed');
  if (!fs.existsSync(metricsPath)) fail('LiteSVM test did not write its successful metrics report');
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  assert.equal(metrics.cases, vectors.length + 2);
  assert.equal(metrics.successful_vectors, vectors.length);
  assert.deepEqual(metrics.rejected_overlimits, ['17-slices','1025-bytes']);
  assert.deepEqual(metrics.observations.map((row:any) => row.name), vectors.map(row => row.name));
  assert.deepEqual(metrics.observations.map((row:any) => [row.input_bytes,row.slice_count]),
    vectors.map(row => [row.parts.map(bytes).reduce((sum,part) => sum + part.length,0),row.parts.length]));
  assert(metrics.observations.every((row:any) => Number.isSafeInteger(row.compute_units) && row.compute_units > 0));
  assert.equal(metrics.max_compute_units,Math.max(...metrics.observations.map((row:any) => row.compute_units)));
  assert.equal(metrics.elf_bytes,fs.statSync(path.join(runDir,'sha256.so')).size);
  assert.deepEqual(Object.fromEntries(compiledFiles.map(file => [file,hashFile(path.join(runDir,file))])),
    compiledHashes, 'compiled SHA artifacts changed during acceptance');
  assert.deepEqual(Object.fromEntries(inputFiles.map(file => [file,hashFile(file)])), inputHashes,
    'SHA inputs changed during acceptance; refusing success receipt');
  for (const [tool, expected] of Object.entries(toolHashes)) {
    assert.equal(toolPath(tool), expected.path, `tool resolution changed: ${tool}`);
    assert.equal(hashFile(expected.path), expected.sha256, `tool changed: ${tool}`);
  }
  const report = {
    schemaVersion: 1,
    passed: true,
    compiledBeforeExecution: compiledHashes,
    completedAtUtc: new Date().toISOString(),
    toolTrust: 'Recorded compiler and Cargo binaries are trusted; Cargo JSON associates the executed Rust binary with source. Hashes alone do not prove that association.',
    scope: 'generic bounded SHA-256 runtime/offchain/SBF foundation; no Bend intrinsic',
    limits: {maxSlices: SHA256_MAX_SLICES, maxBytes: SHA256_MAX_BYTES, digestBytes: 32},
    inputs: inputHashes,
    artifacts: Object.fromEntries([
      'cargo-artifacts.jsonl', 'sha256-native', 'sha256.o', 'sha256.memory.o', 'sha256.su', 'sha256.memory.su', 'sha256.so', 'sbf-metrics.json',
    ].map(file => [file, {sha256: hashFile(path.join(runDir, file)), bytes: fs.statSync(path.join(runDir, file)).size}])),
    executedRustTestBinaries: testArtifacts.map(file => ({path: file, sha256: hashFile(file), bytes: fs.statSync(file).size})),
    vectorInputs: vectors.map(vector => {
      const parts = vector.parts.map(bytes);
      const concatenated = Buffer.concat(parts.map(part => Buffer.from(part)));
      const instruction = encodeInstruction(parts);
      return {
        name: vector.name,
        slices: parts.map(part => ({bytes: part.byteLength,
          sha256: createHash('sha256').update(part).digest('hex')})),
        concatenatedBytes: concatenated.byteLength,
        concatenatedSha256: createHash('sha256').update(concatenated).digest('hex'),
        instructionBytes: instruction.byteLength,
        instructionSha256: createHash('sha256').update(instruction).digest('hex'),
      };
    }),
    tools: toolHashes,
    versions: {
      bun: process.versions.bun ?? null,
      nodeCompat: process.versions.node ?? null,
      hostCompiler: nativeVersion.split('\n')[0],
      sbfCompiler: sbf.clangVersion.split('\n')[0],
      sbfLinker: sbf.linkerVersion.split('\n')[0],
      sbfReadelf: sbf.readelfVersion.split('\n')[0],
      cargo: cargoVersion,
      rustc: rustcVersion,
      litesvm: '0.7.1',
    },
    nativeSanitizers: ['address', 'undefined'],
    sbf: {target: 'SBPFv0', imports: sbf.imports, maxFrameBytes: sbf.frameBytes, ...metrics},
    vectorCases: vectors.length,
  };
  const reportPath = path.join(runDir, 'report.json');
  const pendingPath = reportPath + '.pending';
  fs.writeFileSync(pendingPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
  fs.renameSync(pendingPath, reportPath);
  console.log(`SHA-256 slice passed: ${reportPath}`);
  console.log(`vectors=${vectors.length} SBF maxCU=${metrics.max_compute_units} frame=${sbf.frameBytes} bytes ELF=${metrics.elf_bytes} bytes`);
}

await main();
