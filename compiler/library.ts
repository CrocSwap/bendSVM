import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend, checkedProgram, mangle } from './backend.ts';
import { emitCodecs } from './codecs.ts';
import { wireLayouts } from './schema.ts';
import type { RuntimeSchema } from './schema.ts';
import { BEND_COMMIT, run } from '../scripts/build.ts';
import { libraryTarget, legacyLibraryTarget, libraryTools, checkLibraryTools, assertLibraryObject, assertLibrarySections } from './target-profile.ts';
import type { LibraryTarget } from './target-profile.ts';

const ABI_VERSION = 1;
const FRAME_LIMIT = 4096;
const WIRE_LIMIT = 1024;
const ABI_STATUS = {
  OK: 0,
  NULL: 1,
  RANGE: 2,
  ALIAS: 3,
  MALFORMED_INPUT: 4,
  SHORT_OUTPUT: 5,
  MISALIGNED_OUTPUT_LEN: 6,
  OUTPUT_ENCODING: 7,
} as const;

const LIBRARY_SUPPORT_INPUTS = [
  'compiler/backend.ts', 'compiler/type-evaluation.ts', 'compiler/tagged-sum-ir.ts', 'compiler/native-arithmetic.ts', 'compiler/primitives.ts',
  'compiler/diagnostics.ts', 'compiler/library.ts', 'compiler/target-profile.ts', 'compiler/codecs.ts', 'compiler/schema.ts',
  'scripts/build-library.ts', 'scripts/build.ts', 'runtime/memory.c', 'package.json',
  'package-lock.json', 'Cargo.lock',
];
const BEND_CHECKER = path.resolve('.deps/bend/bend2/bend.ts');

type InputSnapshot = Map<string, string>;

function realFile(file: string): string {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Missing library input: ${absolute}`);
  return fs.realpathSync(absolute);
}

function bendImportClosure(source: string): string[] {
  const files = new Set<string>();
  const visit = (file: string) => {
    const absolute = realFile(file);
    if (files.has(absolute)) return;
    files.add(absolute);
    const lines = fs.readFileSync(absolute, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^import(\s.*|)$/.test(line)) {
        const match = line.match(/^import\s+(\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*(?:#.*)?$/);
        if (!match || (match[2] === undefined && match[1] !== 'Base')) {
          throw new Error(`Cannot capture Bend import before checking: ${line}`);
        }
        if (match[2] === undefined) {
          visit(path.join(path.dirname(BEND_CHECKER), 'base.bend'));
        } else {
          const imported = match[1];
          let resolved: string;
          if (imported.startsWith('/')) resolved = imported;
          else if (/^0x[0-9a-f]+\//.test(imported)) {
            resolved = path.join(process.env.BEND_LIB ?? path.join(process.env.HOME ?? '', '.bend', 'lib'), imported);
          } else resolved = path.resolve(path.dirname(absolute), imported);
          visit(resolved);
        }
        continue;
      }
      if (line !== '' && !line.startsWith('#')) break;
    }
  };
  visit(source);
  return [...files].sort();
}

function snapshotInputs(files: string[]): InputSnapshot {
  const snapshot: InputSnapshot = new Map();
  for (const file of files) {
    const absolute = realFile(file);
    snapshot.set(absolute, hashFile(absolute));
  }
  assertSnapshotUnchanged(snapshot, 'while capturing library inputs');
  return snapshot;
}

function assertSnapshotUnchanged(snapshot: InputSnapshot, when: string): void {
  for (const [file, expected] of snapshot) {
    const actual = hashFile(file);
    if (actual !== expected) throw new Error(`Library input changed ${when}: ${manifestPath(file)}`);
  }
}

type BendObservation = {
  expectedCommit: string;
  observedCommit: string;
  clean: boolean;
  checkerPath: string;
  checkerSha256: string;
};

function observePinnedBend(): BendObservation {
  const observedCommit = run('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], true);
  const status = run('git', ['-C', '.deps/bend', 'status', '--porcelain'], true);
  const clean = status === '';
  if (observedCommit !== BEND_COMMIT || !clean) {
    throw new Error(`Bend dependency is not clean at the pinned revision (${observedCommit})`);
  }
  return {
    expectedCommit: BEND_COMMIT,
    observedCommit,
    clean,
    checkerPath: manifestPath(BEND_CHECKER),
    checkerSha256: hashFile(BEND_CHECKER),
  };
}

function assertSameBend(before: BendObservation, after: BendObservation): void {
  if (!after.clean || after.observedCommit !== before.observedCommit ||
      after.checkerSha256 !== before.checkerSha256) {
    throw new Error('Pinned Bend checker or clean revision changed during library build');
  }
}

const LIBRARY_MODULE_LOAD_INPUTS = snapshotInputs([
  ...LIBRARY_SUPPORT_INPUTS.map(file => path.resolve(file)), BEND_CHECKER,
]);

type Tool = {
  path: string;
  launcherPath: string;
  launcherSymlinkTarget?: string;
  launcherSha256: string;
  compilerBinaryPath: string;
  compilerBinarySha256: string;
  version: string;
};

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifestPath(file: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? absolute : relative;
}

function toolPath(command: string): string {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    if (!fs.existsSync(command)) throw new Error(`Cannot locate compiler executable: ${command}`);
    return path.resolve(command);
  }
  const found = spawnSync('which', [command], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim()) throw new Error(`Cannot locate compiler executable: ${command}`);
  return path.resolve(found.stdout.trim());
}

function tool(command: string, args: string[]): Tool {
  const launcherPath = toolPath(command);
  const launcherSymlinkTarget = fs.lstatSync(launcherPath).isSymbolicLink()
    ? fs.readlinkSync(launcherPath) : undefined;
  let compilerBinaryPath = fs.realpathSync(launcherPath);
  if (process.platform === 'darwin' && compilerBinaryPath === '/usr/bin/clang') {
    const xcrun = spawnSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' });
    if (xcrun.status === 0 && xcrun.stdout.trim()) compilerBinaryPath = fs.realpathSync(xcrun.stdout.trim());
  }
  const version = run(launcherPath, args, true);
  return {
    path: compilerBinaryPath,
    launcherPath,
    ...(launcherSymlinkTarget ? { launcherSymlinkTarget } : {}),
    launcherSha256: hashFile(launcherPath),
    compilerBinaryPath,
    compilerBinarySha256: hashFile(compilerBinaryPath),
    version: version.split('\n')[0],
  };
}

function libraryIdentity(schema: RuntimeSchema, root: string) {
  const exported = schema.exports.find(entry => entry.name === root);
  if (!exported) throw new Error(`Library root was not emitted: ${root}`);
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ abiVersion: ABI_VERSION, root, schemaVersion: schema.version, export: exported,
      types: schema.types }))
    .digest('hex');
  return { fingerprint, symbol: `bend_library_v${ABI_VERSION}_call_${fingerprint}` };
}

function statusDefinitions(prefix: string): string {
  return Object.entries(ABI_STATUS).map(([name, value]) => `#define ${prefix}_${name} ${value}u`).join('\n');
}

function includedHeader(symbol: string, fingerprint: string, inputBytes: number, outputBytes: number): string {
  return `/* Stable call boundary for a checked Bend library; canonical bytes carry the root schema. */
#pragma once
#include <stdint.h>

#define BEND_LIBRARY_ABI_VERSION ${ABI_VERSION}u
#define BEND_LIBRARY_SCHEMA_FINGERPRINT "${fingerprint}"
#define BEND_LIBRARY_INPUT_BYTES ${inputBytes}u
#define BEND_LIBRARY_OUTPUT_BYTES ${outputBytes}u
#define BEND_LIBRARY_CALL ${symbol}
#define BEND_LIBRARY_V1_INPUT_BYTES ${inputBytes}u
#define BEND_LIBRARY_V1_OUTPUT_BYTES ${outputBytes}u
${statusDefinitions('BEND_LIBRARY_ABI')}

/* Input is the concatenation of fixed-width canonical v1 argument values. */
uint32_t ${symbol}(const uint8_t *input, uint64_t input_len,
    uint8_t *output, uint64_t output_capacity, uint64_t *output_len);
`;
}

function rustBindings(symbol: string, fingerprint: string, inputBytes: number, outputBytes: number): string {
  const statuses = Object.entries(ABI_STATUS).map(([name, value]) =>
    `pub const BEND_LIBRARY_ABI_${name}: u32 = ${value};`).join('\n');
  return `// Generated from the checked root/schema contract; do not edit.
pub const BEND_LIBRARY_ABI_VERSION: u32 = ${ABI_VERSION};
pub const BEND_LIBRARY_SCHEMA_FINGERPRINT: &str = "${fingerprint}";
pub const BEND_LIBRARY_INPUT_BYTES: usize = ${inputBytes};
pub const BEND_LIBRARY_OUTPUT_BYTES: usize = ${outputBytes};
${statuses}

extern "C" {
    #[link_name = "${symbol}"]
    pub fn bend_library_call(
        input: *const u8,
        input_len: u64,
        output: *mut u8,
        output_capacity: u64,
        output_len: *mut u64,
    ) -> u32;
}
`;
}

function emitCall(schema: RuntimeSchema, root: string, headerName: string): {
  source: string; inputBytes: number; outputBytes: number; fingerprint: string; symbol: string; bindings: string;
} {
  const exported = schema.exports.find(entry => entry.name === root);
  if (!exported) throw new Error(`Library root was not emitted: ${root}`);
  const sizes = wireLayouts(schema);
  const inputBytes = exported.args.reduce((total, name) => total + sizes.get(name)!, 0);
  const outputBytes = sizes.get(exported.result)!;
  if (!Number.isSafeInteger(inputBytes) || inputBytes > WIRE_LIMIT) {
    throw new Error(`Canonical library input exceeds ${WIRE_LIMIT} bytes (${inputBytes})`);
  }
  if (outputBytes > WIRE_LIMIT) throw new Error(`Canonical library output exceeds ${WIRE_LIMIT} bytes (${outputBytes})`);
  const { fingerprint, symbol } = libraryIdentity(schema, root);

  const declarations = exported.args.map((type, index) =>
    `  ${schema.types.find(value => value.name === type)!.cType} argument_${index};`).join('\n');
  const decode = exported.args.map((type, index) => {
    const offset = exported.args.slice(0, index).reduce((n, earlier) => n + sizes.get(earlier)!, 0);
    return `  if (!${mangle(type)}_decode(input + ${offset}u, ${sizes.get(type)}u, &argument_${index}))\n` +
      '    return BEND_LIBRARY_ABI_MALFORMED_INPUT;';
  }).join('\n');
  const call = `${exported.cName}(${exported.args.map((_, index) => `argument_${index}`).join(', ')})`;
  const resultType = schema.types.find(value => value.name === exported.result)!.cType;
  return {
    inputBytes,
    outputBytes,
    fingerprint,
    symbol,
    bindings: rustBindings(symbol, fingerprint, inputBytes, outputBytes),
    source: `
#include <stdint.h>
#include <limits.h>
#include <stddef.h>
#include "${headerName}"

static int bend_library_range_ok(const void *pointer, uint64_t length) {
  if (length == 0) return 1;
  if (!pointer || length - 1u > (uint64_t)UINTPTR_MAX) return 0;
  return (uintptr_t)pointer <= UINTPTR_MAX - (uintptr_t)(length - 1u);
}

static int bend_library_overlap(const void *left, uint64_t left_length,
    const void *right, uint64_t right_length) {
  if (left_length == 0 || right_length == 0) return 0;
  const uintptr_t left_start = (uintptr_t)left;
  const uintptr_t right_start = (uintptr_t)right;
  const uintptr_t left_end = left_start + (uintptr_t)(left_length - 1u);
  const uintptr_t right_end = right_start + (uintptr_t)(right_length - 1u);
  return left_start <= right_end && right_start <= left_end;
}

__attribute__((visibility("default"), noinline))
uint32_t ${symbol}(const uint8_t *input, uint64_t input_len,
    uint8_t *output, uint64_t output_capacity, uint64_t *output_len) {
  /* Keep this status order stable: null, range, alignment, alias, input, capacity, encoding. */
  if (!output_len || !output || (!input && input_len != 0)) return BEND_LIBRARY_ABI_NULL;
  if (!bend_library_range_ok(input, input_len) ||
      !bend_library_range_ok(output, output_capacity) ||
      !bend_library_range_ok(output_len, sizeof(*output_len))) return BEND_LIBRARY_ABI_RANGE;
  if ((uintptr_t)output_len % _Alignof(uint64_t) != 0) return BEND_LIBRARY_ABI_MISALIGNED_OUTPUT_LEN;
  if (bend_library_overlap(input, input_len, output, output_capacity) ||
      bend_library_overlap(input, input_len, output_len, sizeof(*output_len)) ||
      bend_library_overlap(output, output_capacity, output_len, sizeof(*output_len))) return BEND_LIBRARY_ABI_ALIAS;
  if (input_len != ${inputBytes}u) return BEND_LIBRARY_ABI_MALFORMED_INPUT;
${declarations}
${decode}
  if (output_capacity < ${outputBytes}u) return BEND_LIBRARY_ABI_SHORT_OUTPUT;
  ${resultType} result = ${call};
  uint8_t encoded[${outputBytes}u];
  if (!${mangle(exported.result)}_encode(encoded, ${outputBytes}u, &result))
    return BEND_LIBRARY_ABI_OUTPUT_ENCODING;
  __builtin_memcpy(output, encoded, ${outputBytes}u);
  *output_len = ${outputBytes}u;
  return BEND_LIBRARY_ABI_OK;
}
`,
  };
}

function sourceForBookFile(file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^import(\s.*|)$/.test(line)) {
      lines[index] = '';
      continue;
    }
    if (line !== '' && !line.startsWith('#')) break;
  }
  return lines.join('\n');
}

function rejectProofFileRoot(checked: Awaited<ReturnType<typeof checkedProgram>>, root: string) {
  const definition = checked.book.tlds[root] as {
    $?: string;
    s?: { src?: string };
    v?: { s?: { src?: string } };
  } | undefined;
  if (!definition) throw new Error(`Library root was not emitted: ${root}`);
  if (definition.$ !== 'Def') throw new Error(`Library root is not a runtime definition: ${root}`);
  const source = definition?.v?.s?.src ?? definition?.s?.src;
  if (typeof source !== 'string') {
    throw new Error(`Could not establish the source file for library root ${root}`);
  }
  const origins = checked.files.filter(file => sourceForBookFile(file) === source);
  if (origins.length !== 1) {
    throw new Error(`Could not uniquely establish the source file for library root ${root}`);
  }
  const basename = path.basename(origins[0]);
  if (basename === 'PROOF.bend' || basename === 'LAWS.bend') {
    throw new Error(`Library root cannot originate in PROOF.bend or LAWS.bend: ${root}`);
  }
}

function stackReport(file: string): { maxFrameBytes: number; contents: string } {
  if (!fs.existsSync(file)) throw new Error(`Compiler did not produce stack-usage report: ${file}`);
  const contents = fs.readFileSync(file, 'utf8');
  const frames = contents.trim().split('\n').filter(Boolean).map(line => {
    const [, bytes] = line.split('\t');
    if (!/^\d+$/.test(bytes ?? '')) throw new Error(`Unexpected stack-usage report line: ${line}`);
    return Number(bytes);
  });
  const maxFrameBytes = Math.max(0, ...frames);
  if (maxFrameBytes > FRAME_LIMIT) throw new Error(`Generated frame ${maxFrameBytes} exceeds SBF limit ${FRAME_LIMIT}`);
  return { maxFrameBytes, contents };
}

export async function buildLibrary(source: string, root: string, stem: string, target?: LibraryTarget) {
  const profile = target === undefined ? legacyLibraryTarget() : libraryTarget(target);
  const toolsDir = libraryTools(profile);
  checkLibraryTools(profile, toolsDir);
  const previous = `${stem}.manifest.json`;
  const prior = fs.existsSync(previous) ? JSON.parse(fs.readFileSync(previous, 'utf8')) : undefined;
  if (prior && (prior.targetProfile !== profile.name ||
      prior.toolchains?.anzaClang?.platformTools !== profile.platformTools)) {
    throw new Error(`Refusing to overwrite a library from another target at ${stem}; use isolated output directories`);
  }
  const bendSources = bendImportClosure(source);
  const capturedInputs = snapshotInputs([
    ...bendSources,
    ...LIBRARY_SUPPORT_INPUTS.map(file => path.resolve(file)),
    BEND_CHECKER,
  ]);
  for (const [file, loadedHash] of LIBRARY_MODULE_LOAD_INPUTS) {
    if (capturedInputs.get(file) !== loadedHash) {
      throw new Error(`Library source changed after compiler module load: ${manifestPath(file)}`);
    }
  }
  const bendBefore = observePinnedBend();
  if (capturedInputs.get(realFile(BEND_CHECKER)) !== bendBefore.checkerSha256) {
    throw new Error('Pinned Bend checker changed while capturing library inputs');
  }
  if (path.basename(source) !== 'PROOF.bend') {
    throw new Error('A library build must start from PROOF.bend so checkedProgram enforces adjacent LAWS.bend imports');
  }
  if (!fs.existsSync(path.join(path.dirname(path.resolve(source)), 'LAWS.bend'))) {
    throw new Error('A library build requires adjacent LAWS.bend');
  }
  const checked = await checkedProgram(source);
  for (const file of checked.files) {
    const absolute = realFile(file);
    if (!capturedInputs.has(absolute)) {
      throw new Error(`Checked Bend source was not captured before checking: ${manifestPath(absolute)}`);
    }
  }
  assertSnapshotUnchanged(capturedInputs, 'during Bend checking');
  rejectProofFileRoot(checked, root);
  const emitted = new Backend(checked.book).emit([root]);
  const call = emitCall(emitted.schema, root, `${path.basename(stem)}.h`);
  const outputDir = path.dirname(path.resolve(stem));
  const base = path.basename(stem);
  if (!/^[A-Za-z0-9_-]+$/.test(base)) throw new Error('Library artifact basename must use letters, digits, underscore or dash');
  fs.mkdirSync(outputDir, { recursive: true });
  const header = `${stem}.h`;
  const bindingsFile = `${stem}.bindings.rs`;
  const cSource = `${stem}.c`;
  const schemaFile = `${stem}.schema.json`;
  const sbfObject = `${stem}.sbf.o`;
  const hostObject = `${stem}.host.o`;
  const memoryObject = `${stem}.sbf.memory.o`;
  const host = tool(process.env.CC ?? 'clang', ['--version']);
  const anzaClang = tool(path.join(toolsDir, 'clang'), ['--version']);
  const anzaReadelf = tool(path.join(toolsDir, 'llvm-readelf'), ['--version']);
  fs.writeFileSync(header, includedHeader(call.symbol, call.fingerprint, call.inputBytes, call.outputBytes));
  fs.writeFileSync(bindingsFile, call.bindings);
  fs.writeFileSync(schemaFile, JSON.stringify({
    version: 1, abiVersion: ABI_VERSION, root, symbol: call.symbol, schemaFingerprint: call.fingerprint,
    inputBytes: call.inputBytes, outputBytes: call.outputBytes,
    schema: emitted.schema,
  }, null, 2) + '\n');
  const definitions = emitted.c.replace(/^#pragma once\s*$/gm, '');
  const codecs = emitCodecs(emitted.schema).replace(/^#pragma once\s*$/gm, '');
  fs.writeFileSync(cSource, `/* Generated from checked pure Bend terms; do not edit. */\n` +
    definitions + '\n' + codecs + call.source);

  const sbfFlags = ['--target=sbf', `-mcpu=${profile.cpu}`, '-O2', '-fPIC', '-ffreestanding',
    '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-Wno-unused-function',
    `-Wframe-larger-than=${FRAME_LIMIT}`, '-fstack-usage', '-ffunction-sections', '-fdata-sections',
    `-I${outputDir}`, '-Iruntime'];
  run(path.join(toolsDir, 'clang'), [...sbfFlags, '-c', cSource, '-o', sbfObject]);
  run(path.join(toolsDir, 'clang'), [...sbfFlags, '-c', 'runtime/memory.c', '-o', memoryObject]);
  assertLibraryObject(sbfObject, profile);
  assertLibraryObject(memoryObject, profile);
  const readelf = path.join(toolsDir, 'llvm-readelf');
  assertLibrarySections(readelf, sbfObject, profile);
  assertLibrarySections(readelf, memoryObject, profile);
  const sbfSymbols = run(readelf, ['-s', sbfObject], true);
  const allowedUndefined = new Set(['memcpy', 'memmove', 'memset']);
  for (const line of sbfSymbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    const symbol = line.trim().split(/\s+/).at(-1)!;
    if (symbol !== 'UND' && !allowedUndefined.has(symbol)) {
      throw new Error(`Unsupported SBF library object import: ${symbol}`);
    }
  }
  if (!sbfSymbols.split('\n').some(line => /\bGLOBAL\b/.test(line) && line.trim().endsWith(call.symbol))) {
    throw new Error(`SBF library object is missing global export ${call.symbol}`);
  }
  const sbfStack = stackReport(sbfObject.replace(/\.o$/, '.su'));
  const memoryStack = stackReport(memoryObject.replace(/\.o$/, '.su'));
  const hostFlags = ['-std=c17', '-O2', '-fPIC', '-ffreestanding', '-fno-builtin',
    '-Wall', '-Wextra', '-Werror', `-Wframe-larger-than=${FRAME_LIMIT}`, '-fstack-usage',
    '-Wno-unused-function',
    `-I${outputDir}`, '-Iruntime'];
  run(process.env.CC ?? 'clang', [...hostFlags, '-c', cSource, '-o', hostObject]);
  const hostStack = stackReport(hostObject.replace(/\.o$/, '.su'));

  const rootSource = path.resolve(source);
  const inputPaths = [...new Set([
    ...checked.files.map(file => realFile(file)), rootSource,
    ...LIBRARY_SUPPORT_INPUTS.map(file => path.resolve(file)), BEND_CHECKER,
  ])].sort();
  for (const file of inputPaths) {
    if (!capturedInputs.has(realFile(file))) {
      throw new Error(`Build input was not captured before work: ${manifestPath(file)}`);
    }
  }
  const inputHashes = Object.fromEntries(inputPaths.map(file => [
    manifestPath(file), capturedInputs.get(realFile(file))!,
  ]));
  const artifacts = [header, bindingsFile, cSource, schemaFile, sbfObject, hostObject, memoryObject,
    sbfObject.replace(/\.o$/, '.su'), hostObject.replace(/\.o$/, '.su'),
    memoryObject.replace(/\.o$/, '.su')];
  assertSnapshotUnchanged(capturedInputs, 'before manifest publication');
  checkLibraryTools(profile, toolsDir);
  if (hashFile(anzaClang.path) !== anzaClang.compilerBinarySha256 ||
      hashFile(anzaReadelf.path) !== anzaReadelf.compilerBinarySha256) {
    throw new Error('Library SBF tools changed before manifest publication');
  }
  const bendAfter = observePinnedBend();
  assertSameBend(bendBefore, bendAfter);
  if (capturedInputs.get(realFile(BEND_CHECKER)) !== bendAfter.checkerSha256) {
    throw new Error('Pinned Bend checker changed after library input capture');
  }
  const manifest = {
    version: 1,
    kind: 'bend-library-v1',
    targetProfile: profile.name,
    abiVersion: ABI_VERSION,
    source: path.relative(process.cwd(), rootSource),
    root,
    bendCommit: bendAfter.observedCommit,
    symbol: call.symbol,
    schemaFingerprint: call.fingerprint,
    checkedFiles: checked.files.map(manifestPath),
    emittedFunctions: emitted.functions,
    canonicalInputBytes: call.inputBytes,
    canonicalOutputBytes: call.outputBytes,
    frameLimitBytes: FRAME_LIMIT,
    maxFrameBytes: Math.max(sbfStack.maxFrameBytes, memoryStack.maxFrameBytes, hostStack.maxFrameBytes),
    selection: {
      hostSource: path.basename(cSource), hostObject: path.basename(hostObject),
      sbfSource: path.basename(cSource), sbfObject: path.basename(sbfObject),
      memoryObject: path.basename(memoryObject), header: path.basename(header),
      bindings: path.basename(bindingsFile), schema: path.basename(schemaFile),
    },
    finalElfAuthorized: false,
    toolchains: {
      hostC: host,
      anzaClang: { ...anzaClang, platformTools: profile.platformTools, cpu: profile.cpu, sbpfVersion: profile.sbpfVersion },
      anzaReadelf,
    },
    dependencies: {
      bendCommit: bendAfter.observedCommit,
      bendChecker: {
        expectedCommit: bendAfter.expectedCommit,
        observedCommitBefore: bendBefore.observedCommit,
        observedCommitAfter: bendAfter.observedCommit,
        cleanBefore: bendBefore.clean,
        cleanAfter: bendAfter.clean,
        path: bendAfter.checkerPath,
        sha256Before: bendBefore.checkerSha256,
        sha256After: bendAfter.checkerSha256,
      },
      packageLockSha256: hashFile('package-lock.json'),
      cargoLockSha256: hashFile('Cargo.lock'),
    },
    inputs: inputHashes,
    artifacts: Object.fromEntries(artifacts.map(file => [
      path.basename(file), { bytes: fs.statSync(file).size, sha256: hashFile(file) },
    ])),
  };
  fs.writeFileSync(`${stem}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built checked Bend library ${root}: ${sbfObject}, ${hostObject}; max frame ${manifest.maxFrameBytes}/${FRAME_LIMIT} bytes`);
  return manifest;
}
