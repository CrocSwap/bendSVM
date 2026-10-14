// Controls for scripts/install-platform-tools.ts that need no download: unpinned
// hosts, archives with the wrong hash, and mismatched existing installations are
// refused without leaving partial state; a pinned installation verifies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPlatformTools, v157Mismatches } from '../scripts/install-platform-tools.ts';
import { V157_DEFAULT_ROOT, V157_HOSTS, v157Host } from '../compiler/target-profile.ts';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bend-platform-tools-'));
const leftovers = () => fs.readdirSync(parent).filter(name => name.startsWith('.platform-tools-v1.57-'));
try {
  assert.equal(v157Host('win32', 'x64'), undefined);
  assert.equal(v157Host('linux', 'x64'), 'linux-x64');
  assert.throws(() => installPlatformTools({ host: 'win32-x64', root: path.join(parent, 'win') }), /pinned for macOS arm64, Linux x86_64 and Linux aarch64/);

  const fake = path.join(parent, 'fake.tar.bz2');
  fs.writeFileSync(fake, 'not the release archive');
  const host = v157Host() ?? 'linux-x64';
  assert.throws(() => installPlatformTools({ host, root: path.join(parent, 'fresh'), archive: fake }), /has SHA-256 .* expected/);
  assert(!fs.existsSync(path.join(parent, 'fresh')), 'a refused archive must not create the installation');
  assert.deepEqual(leftovers(), [], 'a refused archive must not leave staging directories');

  const tampered = path.join(parent, 'tampered');
  fs.mkdirSync(path.join(tampered, 'llvm/bin'), { recursive: true });
  fs.writeFileSync(path.join(tampered, 'llvm/bin/clang'), 'shim');
  assert.throws(() => installPlatformTools({ host, root: tampered }), /exists but .* differ from the v1\.57 pins.*not overwritten/);
  assert.equal(fs.readFileSync(path.join(tampered, 'llvm/bin/clang'), 'utf8'), 'shim', 'an existing installation is never modified');

  const usage = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../scripts/install-platform-tools.ts'), '--bogus'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: npm run install:platform-tools/);

  // A real installation on this host (default cache or SBF_V157_TOOLS) verifies in place.
  const installed = process.env.SBF_V157_TOOLS ? path.resolve(process.env.SBF_V157_TOOLS, '../..') : V157_DEFAULT_ROOT;
  const native = v157Host();
  let verified = 'no local installation';
  if (native && fs.existsSync(installed)) {
    assert.deepEqual(v157Mismatches(installed, V157_HOSTS[native].tools), []);
    assert.deepEqual(installPlatformTools({ root: installed }), { root: installed, installed: false });
    verified = `verified ${installed}`;
  }
  console.log(`Platform-tools installer controls passed: unpinned host, wrong archive hash and mismatched installation refused without partial state; ${verified}`);
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}
