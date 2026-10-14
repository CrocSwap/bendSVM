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

/**
 * Anza platform-tools v1.57 release archives and the binaries Bend runs, pinned
 * by SHA-256 per host. The macOS arm64 binaries are the ones GoSVM qualified;
 * all three archives were downloaded from the v1.57 GitHub release on 2026-10-14.
 */
export const V157_HOSTS = {
  'darwin-arm64': {
    archive: 'platform-tools-osx-aarch64.tar.bz2',
    archiveSha256: '48c32c2ec3ac3729b5caf1fdd6c4145496125edf043b2662b0586bfbc932b34a',
    tools: {
      clang: '67ebfa7313086cf01ddb42d6cdf3b4bba741dc2341a1e70796d018fe7b9ee697',
      'llvm-readelf': 'b0e56e720c675f76804612a944154ff99bbf72f6ecbcb876ef53cee68eff5698',
      'ld.lld': '91db7cf05b55facfdb7178eb24d6e5eba1da369672f2b52ab1657165a6441630',
    },
  },
  'linux-x64': {
    archive: 'platform-tools-linux-x86_64.tar.bz2',
    archiveSha256: 'b0f7af104adf726fff2a6a09ea2eb2f2d2965c92295f4d7388c08d140e0c2b00',
    tools: {
      clang: '6672ea42140527104c230c995992edf7147308a370ae3e52163821896d9b8c1a',
      'llvm-readelf': '008aa4b309a200d4a7e679b95ce78974a82f8a36b29943d01ee0e80a0019ef6a',
      'ld.lld': 'e54c88f3021702b13527e4b255e0e299420ebe11d17ece99a338a5d789ef18ed',
    },
  },
  'linux-arm64': {
    archive: 'platform-tools-linux-aarch64.tar.bz2',
    archiveSha256: 'f2f31c9325cb2d00244df23b4a1a0904e51819cec49d39235a3ed3ee2320375d',
    tools: {
      clang: 'eba6e975225cfd44291bdcace57f1e9a6e3c4942be98475468a74f5b4789ac78',
      'llvm-readelf': '53b7f91b3fc623f1e6c6382ad42f25b07e24948f472d32645e99c41ba0df2c9e',
      'ld.lld': 'bc01c50986b5c38501df0fc1d57d7f702850c05e01ec4dd39376998bd3a5cdfb',
    },
  },
} as const;
export type V157Host = keyof typeof V157_HOSTS;
export const V157_RELEASE_URL = 'https://github.com/anza-xyz/platform-tools/releases/download/v1.57';
export const V157_DEFAULT_ROOT = path.join(os.homedir(), '.cache/solana/v1.57/platform-tools');

/** The pinned v1.57 host entry for this machine, or undefined when no pin exists. */
export function v157Host(platform: string = process.platform, arch: string = process.arch): V157Host | undefined {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(V157_HOSTS, key) ? key as V157Host : undefined;
}
export const SUPPORTED_V157_HOSTS = 'macOS arm64, Linux x86_64 and Linux aarch64';

/** v1.57 tool pins for this host ({} on an unsupported host). */
export const MODERN_TOOL_HASHES: Record<string, string> = (() => {
  const host = v157Host();
  return host ? { ...V157_HOSTS[host].tools } : {};
})();

/** SBF_TOOLS selects v1.53; SBF_V157_TOOLS (alias SBF_V3_TOOLS) selects v1.57. */
export function libraryTools(profile: LibraryTargetProfile): string {
  return profile.platformTools === 'v1.53' ? sbfTools() :
    process.env.SBF_V157_TOOLS ?? process.env.SBF_V3_TOOLS ??
      path.join(V157_DEFAULT_ROOT, 'llvm/bin');
}

export function checkLibraryTools(profile: LibraryTargetProfile, directory: string,
    names: string[] = ['clang', 'llvm-readelf']): void {
  if (profile.platformTools === 'v1.57' && !v157Host()) {
    throw new Error(`${profile.name} library tools (platform-tools v1.57) are pinned for ${SUPPORTED_V157_HOSTS}; host is ${process.platform}/${process.arch}`);
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
