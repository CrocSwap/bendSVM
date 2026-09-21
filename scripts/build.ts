import fs from 'node:fs';
import {TargetDiagnostic} from '../compiler/diagnostics.ts';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const BEND_COMMIT = '7561656155a4285c1e4ccfcb3505ab59524de973';
export function run(cmd: string, args: string[], capture = false): string {
  const p = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, BEND_NO_TELEMETRY: '1' } });
  if (p.error || p.status !== 0) throw new Error(`${cmd} failed (${p.status}): ${p.error ?? p.stderr ?? ''}`);
  return p.stdout?.trim() ?? '';
}
export function sbfTools(): string {
  return process.env.SBF_TOOLS ?? path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin');
}
export function compileSbf(source: string, stem: string) {
  const tools = sbfTools();
  const clang = path.join(tools, 'clang');
  const version = run(clang, ['--version'], true);
  if (!version.includes('20.1.7') || !version.includes('anza-xyz')) {
    throw new Error('Expected Anza platform-tools v1.53 clang 20.1.7; set SBF_TOOLS to its llvm/bin');
  }
  const flags = ['--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding',
    '-fno-builtin', '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections', '-fdata-sections', '-Ibuild', '-Iruntime'];
  try {run(clang, [...flags, '-c', source, '-o', `${stem}.o`],true);} catch(e) {
    const detail=e instanceof Error?e.message:String(e);
    if(/stack frame|frame size|stack limit/i.test(detail))throw new TargetDiagnostic('BEND-SBF203',detail,'Reduce per-call window size or live temporaries. SBF permits at most 4096 bytes per frame.');
    throw e;
  }
  const usage=fs.readFileSync(`${stem}.su`,'utf8').trim().split('\n').filter(Boolean).map(line=>{
    const [location,bytes,kind]=line.split('\t');
    if(!location||!/^\d+$/.test(bytes??''))throw new Error('Unexpected Clang stack-usage report');
    return {location:path.basename(location),bytes:Number(bytes),kind};
  });
  fs.writeFileSync(`${stem}.stack.json`,JSON.stringify({version:1,frameLimit:4096,maxFrameBytes:Math.max(0,...usage.map(f=>f.bytes)),functions:usage},null,2)+'\n');
  run(clang, [...flags, '-c', 'runtime/memory.c', '-o', `${stem}.memory.o`]);
  run(path.join(tools, 'ld.lld'), ['-z', 'notext', '-shared', '--Bdynamic',
    'runtime/sbf.ld', '--entry', 'entrypoint', '-z', 'max-page-size=4096',
    '--gc-sections', `${stem}.o`, `${stem}.memory.o`, '-o', `${stem}.so`]);
  const symbols = run(path.join(tools,'llvm-readelf'),['-s',`${stem}.so`],true);
  const allowed = new Set(['sol_set_return_data','sol_get_clock_sysvar','sol_try_find_program_address',
    'sol_invoke_signed_c','sol_memcpy_','sol_memmove_','sol_memset_']);
  for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    const symbol = line.trim().split(/\s+/).at(-1)!;
    if (symbol !== 'UND' && !allowed.has(symbol)) throw new Error(`Unsupported SBF import: ${symbol}`);
  }
  return { tools, version };
}
export function prepareBend() {
  if (!fs.existsSync('.deps/bend/.git')) {
    fs.mkdirSync('.deps/bend', { recursive: true });
    run('git', ['init', '-q', '.deps/bend']);
    run('git', ['-C', '.deps/bend', 'remote', 'add', 'origin', 'https://github.com/bendlang/bend.git']);
    run('git', ['-C', '.deps/bend', 'fetch', '-q', '--depth=1', 'origin', BEND_COMMIT]);
    run('git', ['-C', '.deps/bend', 'checkout', '-q', '--detach', 'FETCH_HEAD']);
  }
  if (run('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], true) !== BEND_COMMIT ||
      run('git', ['-C', '.deps/bend', 'status', '--porcelain'], true)) {
    throw new Error('Bend dependency must be clean and at the pinned commit');
  }
}
export async function build() {
  fs.mkdirSync('build', { recursive: true });
  prepareBend();
  const { checkedBook, Backend, describeError } = await import('../compiler/backend.ts');
  const { writeArtifacts } = await import('../compiler/artifacts.ts');
  try {
    const book = await checkedBook('examples/escrow/PROOF.bend');
    const emitted = new Backend(book).emit(['escrow.release']);
    writeArtifacts('build/escrow', emitted);
    console.log('Bend proof gate passed; emitted:', emitted.functions.join(', '));
    // Explicit legacy SBPFv0 target for the pinned LiteSVM/Agave runtime.
    const { tools, version } = compileSbf('runtime/entrypoint.c', 'build/escrow');
    const inspect = run(path.join(tools, 'llvm-readelf'), ['-h', '-S', '-s', 'build/escrow.so'], true);
    fs.writeFileSync('build/elf.txt', inspect + '\n');
    fs.writeFileSync('build/escrow.disasm', run(path.join(tools, 'llvm-objdump'), ['-d', 'build/escrow.so'], true) + '\n');
    const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const inputs = ['examples/escrow/escrow.bend', 'examples/escrow/LAWS.bend',
      'examples/escrow/PROOF.bend', 'compiler/backend.ts', 'runtime/entrypoint.c',
      'runtime/solana_min.h', 'runtime/sbf.ld', 'scripts/build.ts', 'compiler/primitives.ts',
      'compiler/schema.ts', 'compiler/codecs.ts', 'compiler/dispatch.ts', 'compiler/artifacts.ts',
      'compiler/storage.ts', 'compiler/effects.ts', 'runtime/memory.c'];
    const manifest = { bendCommit: BEND_COMMIT, compiler: version.split('\n')[0],
      platformTools: 'v1.53', target: 'sbf', cpu: 'generic', sbpfVersion: 0, exports: ['escrow.release'],
      emittedFunctions: emitted.functions, inputs: Object.fromEntries(inputs.map(f => [f, hash(f)])),
      elfSha256: hash('build/escrow.so'), elfBytes: fs.statSync('build/escrow.so').size };
    fs.writeFileSync('build/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Built build/escrow.so (${manifest.elfBytes} bytes; SBPFv0)`);
  } catch (e) { throw new Error(describeError(e)); }
}
if (import.meta.main) await build();
