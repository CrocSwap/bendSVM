import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, sbfTools } from '../scripts/build.ts';

export type LibraryTarget = 'fogo-v0' | 'solana-v3';
/** Explicit targets use the platform-tools v1.57 backend shared with GoSVM. */
export function libraryTarget(name: string = 'fogo-v0') {
  switch (name) {
    case 'fogo-v0': return { name: name as LibraryTarget, platformTools: 'v1.57', llvm: '22.1.2',
      cpu: 'generic', sbpfVersion: 0, machine: 263 };
    case 'solana-v3': return { name: name as LibraryTarget, platformTools: 'v1.57', llvm: '22.1.2',
      cpu: 'v3', sbpfVersion: 3, machine: 247 };
    default: throw new Error(`Unknown library target ${name}; choose fogo-v0 or solana-v3`);
  }
}
export type LibraryTargetProfile = ReturnType<typeof libraryTarget>;
/** The historical three-argument command: fogo-v0 on the v1.53 backend, any host (CI). */
export function legacyLibraryTarget(): LibraryTargetProfile {
  return { name: 'fogo-v0', platformTools: 'v1.53', llvm: '20.1.7', cpu: 'generic', sbpfVersion: 0, machine: 263 };
}

// macOS arm64 v1.57 candidate shared with GoSVM's recorded qualification.
// Other host packages require separate pins and execution qualification.
export const MODERN_TOOL_HASHES: Record<string, string> = {
  clang: '67ebfa7313086cf01ddb42d6cdf3b4bba741dc2341a1e70796d018fe7b9ee697',
  'llvm-readelf': 'b0e56e720c675f76804612a944154ff99bbf72f6ecbcb876ef53cee68eff5698',
  'ld.lld': '91db7cf05b55facfdb7178eb24d6e5eba1da369672f2b52ab1657165a6441630',
};

/** SBF_TOOLS selects v1.53; SBF_V157_TOOLS (alias SBF_V3_TOOLS) selects v1.57. */
export function libraryTools(profile: LibraryTargetProfile): string {
  return profile.platformTools === 'v1.53' ? sbfTools() :
    process.env.SBF_V157_TOOLS ?? process.env.SBF_V3_TOOLS ??
      path.join(os.homedir(), '.cache/solana/v1.57/platform-tools/llvm/bin');
}

export function checkLibraryTools(profile: LibraryTargetProfile, directory: string,
    names: string[] = ['clang', 'llvm-readelf']): void {
  if (profile.platformTools === 'v1.57' && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
    throw new Error(`${profile.name} library tools (platform-tools v1.57) are currently pinned for macOS arm64 only`);
  }
  for (const name of names) {
    const executable = path.join(directory, name);
    const version = run(executable, ['--version'], true);
    if (!version.includes(profile.llvm) || (name === 'clang' && !version.includes('anza-xyz'))) {
      throw new Error(`Expected Anza platform-tools ${profile.platformTools} ${name} ${profile.llvm} for ${profile.name}`);
    }
    if (profile.platformTools === 'v1.57' &&
        crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== MODERN_TOOL_HASHES[name]) {
      throw new Error(`${profile.name} ${name} does not match the platform-tools ${profile.platformTools} content pin`);
    }
  }
}

/** Explicit profiles get distinct outputs; the historical three-argument command retains its paths. */
export function libraryOutputStem(stem: string, target?: LibraryTarget): string {
  if (target === undefined) return stem;
  const profile = libraryTarget(target);
  return path.join(path.dirname(stem), profile.name, profile.platformTools, path.basename(stem));
}

export function assertLibraryObject(file: string, profile: LibraryTargetProfile): void {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
      bytes.readUInt16LE(16) !== 1 || bytes.readUInt16LE(18) !== profile.machine ||
      bytes.readUInt32LE(20) !== 1 || bytes.readUInt32LE(48) !== profile.sbpfVersion) {
    throw new Error(`Library ${profile.name} requires an ELF64 little-endian SBPFv${profile.sbpfVersion} relocatable object: ${file}`);
  }
}

/** The sbpfv3 Rust link script discards .data and .bss, so writable state would vanish silently. */
export function assertLibrarySections(readelf: string, file: string, profile: LibraryTargetProfile): void {
  if (profile.name !== 'solana-v3') return;
  for (const line of run(readelf, ['-S', '-W', file], true).split('\n')) {
    const match = line.match(/^\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+[0-9a-f]+\s+[0-9a-f]+\s+([0-9a-f]+)\s+[0-9a-f]+\s+(\S*)/);
    if (match && match[3].includes('W') && match[3].includes('A') && parseInt(match[2], 16) !== 0) {
      throw new Error(`${profile.name} library object has writable section ${match[1]}: ${file}`);
    }
  }
}
