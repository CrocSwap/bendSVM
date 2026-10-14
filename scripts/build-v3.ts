// SBPFv3 program compile/link for the solana-v3 profile (platform-tools v1.57).
// The ordinary SBPFv0 path in scripts/build.ts is unchanged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './build.ts';
import { TargetDiagnostic } from '../compiler/diagnostics.ts';
import { assertLibrarySections, checkLibraryTools, libraryTarget, libraryTools } from '../compiler/target-profile.ts';

const FRAME_LIMIT = 4096;
const V3_OBJECTS = [['memory', 'runtime/memory.c'], ['syscalls', 'runtime/sbpfv3_syscalls.c']] as const;

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stackUsage(file: string) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const [location, bytes, kind] = line.split('\t');
    if (!location || !/^\d+$/.test(bytes ?? '')) throw new Error(`Unexpected Clang stack-usage report: ${line}`);
    return { file: path.basename(file), location: path.basename(location), bytes: Number(bytes), kind };
  });
}

/**
 * Compile a generated program C file plus the shared runtime and v3 syscall
 * trampolines, link with the v3 layout and refuse any import, relocation or
 * writable section. The final-image call bound is checked by the caller.
 */
export function compileSbfV3(source: string, stem: string) {
  const profile = libraryTarget('solana-v3');
  const tools = libraryTools(profile);
  checkLibraryTools(profile, tools, ['clang', 'ld.lld', 'llvm-readelf']);
  const clang = path.join(tools, 'clang'), linker = path.join(tools, 'ld.lld'), readelf = path.join(tools, 'llvm-readelf');
  const version = run(clang, ['--version'], true);
  const flags = ['--target=sbf', `-mcpu=${profile.cpu}`, '-O2', '-fPIC', '-ffreestanding',
    '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    `-Wframe-larger-than=${FRAME_LIMIT}`, '-fstack-usage', '-ffunction-sections', '-fdata-sections',
    `-I${path.dirname(path.resolve(stem))}`, '-Ibuild', '-Iruntime'];
  try { run(clang, [...flags, '-c', source, '-o', `${stem}.o`], true); } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (/stack frame|frame size|stack limit/i.test(detail)) throw new TargetDiagnostic('BEND-SBF203', detail,
      'Reduce per-call window size or live temporaries. SBF permits at most 4096 bytes per frame.');
    throw e;
  }
  const objects = [`${stem}.o`];
  for (const [suffix, file] of V3_OBJECTS) {
    run(clang, [...flags, '-c', file, '-o', `${stem}.${suffix}.o`]);
    objects.push(`${stem}.${suffix}.o`);
  }
  for (const object of objects) assertLibrarySections(readelf, object, profile);
  const functions = objects.flatMap(object => stackUsage(object.replace(/\.o$/, '.su')));
  const stack = { version: 1, frameLimit: FRAME_LIMIT, maxFrameBytes: Math.max(0, ...functions.map(f => f.bytes)), functions };
  if (stack.maxFrameBytes > FRAME_LIMIT) throw new TargetDiagnostic('BEND-SBF203',
    `SBF frame ${stack.maxFrameBytes} exceeds ${FRAME_LIMIT} bytes`, 'Reduce per-call window size or live temporaries.');
  fs.writeFileSync(`${stem}.stack.json`, JSON.stringify(stack, null, 2) + '\n');
  // --no-undefined: the v3 linker otherwise emits an unrelocated self-call for a missing symbol.
  run(linker, ['-z', 'notext', '--Bdynamic', '-shared', '--gc-sections', '--entry=entrypoint', '-Bsymbolic',
    '--no-undefined', '--script', 'runtime/sbpfv3.ld', ...objects, '-o', `${stem}.so`]);
  const bytes = fs.readFileSync(`${stem}.so`);
  if (bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== profile.machine || bytes.readUInt32LE(48) !== profile.sbpfVersion) {
    throw new Error('SBPFv3 program must be ET_DYN, EM_BPF, e_flags 3');
  }
  const symbols = run(readelf, ['-s', '-W', `${stem}.so`], true);
  const imports = symbols.split('\n').filter(line => /\bUND\b/.test(line))
    .map(line => line.trim().split(/\s+/).at(-1)!).filter(name => name !== 'UND');
  if (imports.length) throw new Error(`SBPFv3 program must not import symbols: ${imports.join(', ')}`);
  if (!/There are no relocations in this file/.test(run(readelf, ['-r', `${stem}.so`], true))) {
    throw new Error('SBPFv3 program must not contain relocations');
  }
  assertLibrarySections(readelf, `${stem}.so`, profile);
  const toolchain = Object.fromEntries([['clang', clang], ['ld.lld', linker], ['llvm-readelf', readelf]].map(([name, file]) => {
    const resolved = fs.realpathSync(file);
    return [name, { path: resolved, invokedAs: path.resolve(file), sha256: sha256File(resolved) }];
  }));
  return { profile, version, imports, stack, toolchain, objects };
}
