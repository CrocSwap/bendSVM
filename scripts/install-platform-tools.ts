// Install Anza platform-tools v1.57 (the Solana SBPFv3 toolchain) for this host.
// The release archive is checked against its pinned SHA-256 before extraction
// and the clang/ld.lld/llvm-readelf binaries after; an existing installation is
// verified, never overwritten.
//
// Usage: npm run install:platform-tools -- [--root <dir>] [--archive <file>]
//   --root     installation directory (default ~/.cache/solana/v1.57/platform-tools)
//   --archive  use an already downloaded release archive instead of fetching it
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SUPPORTED_V157_HOSTS, V157_DEFAULT_ROOT, V157_HOSTS, V157_RELEASE_URL, v157Host } from '../compiler/target-profile.ts';

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? result.status})`);
};

/** Names of pinned binaries under <root>/llvm/bin that are missing or differ from their pin. */
export function v157Mismatches(root: string, tools: Record<string, string>): string[] {
  return Object.entries(tools).filter(([name, pin]) => {
    const file = path.join(root, 'llvm/bin', name);
    return !fs.existsSync(file) || sha256(file) !== pin;
  }).map(([name]) => name);
}

export function installPlatformTools(options: { root?: string; archive?: string; host?: string } = {}): { root: string; installed: boolean } {
  const host = options.host ?? v157Host();
  if (!host || !Object.hasOwn(V157_HOSTS, host)) {
    throw new Error(`platform-tools v1.57 is pinned for ${SUPPORTED_V157_HOSTS}; host is ${process.platform}/${process.arch}`);
  }
  const pin = V157_HOSTS[host as keyof typeof V157_HOSTS];
  const root = path.resolve(options.root ?? V157_DEFAULT_ROOT);
  if (fs.existsSync(root)) {
    const mismatches = v157Mismatches(root, pin.tools);
    if (mismatches.length) {
      throw new Error(`${root} exists but ${mismatches.join(', ')} ${mismatches.length === 1 ? 'is' : 'are'} missing or differ from the v1.57 pins. ` +
        'Inspect or move it aside, then rerun; it is not overwritten.');
    }
    return { root, installed: false };
  }
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, '.platform-tools-v1.57-'));
  try {
    let archive = options.archive ? path.resolve(options.archive) : path.join(work, pin.archive);
    if (!options.archive) {
      console.error(`Downloading ${V157_RELEASE_URL}/${pin.archive}`);
      run('curl', ['--fail', '--location', '--retry', '3', '--silent', '--show-error', '--output', archive, `${V157_RELEASE_URL}/${pin.archive}`]);
    }
    const digest = sha256(archive);
    if (digest !== pin.archiveSha256) throw new Error(`${archive} has SHA-256 ${digest}; expected ${pin.archiveSha256} for ${pin.archive}`);
    const staged = path.join(work, 'platform-tools');
    fs.mkdirSync(staged);
    console.error(`Extracting ${pin.archive}`);
    run('tar', ['-xjf', archive, '-C', staged]);
    const mismatches = v157Mismatches(staged, pin.tools);
    if (mismatches.length) throw new Error(`Extracted ${mismatches.join(', ')} differ from the v1.57 pins`);
    fs.renameSync(staged, root);
    return { root, installed: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options: { root?: string; archive?: string } = {};
    for (let index = 0; index < args.length; index += 2) {
      const [flag, value] = [args[index], args[index + 1]];
      if (value === undefined || (flag !== '--root' && flag !== '--archive')) {
        throw new Error('Usage: npm run install:platform-tools -- [--root <dir>] [--archive <file>]');
      }
      options[flag === '--root' ? 'root' : 'archive'] = value;
    }
    const { root, installed } = installPlatformTools(options);
    console.log(`${installed ? 'Installed' : 'Verified existing'} platform-tools v1.57 at ${root}`);
    if (path.resolve(root) !== V157_DEFAULT_ROOT) console.log(`Set SBF_V157_TOOLS=${path.join(root, 'llvm/bin')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
