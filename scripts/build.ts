import fs from 'node:fs';
import {TargetDiagnostic} from '../compiler/diagnostics.ts';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { publishAcceptedFinalSbfArtifact, verifyFinalSbfArtifactReceipt } from '../compiler/sbf-call-depth-artifact.ts';

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
function archivePriorBuildEvidence(): string | null {
  const manifestPath = 'build/manifest.json';
  if (!fs.existsSync(manifestPath)) return null;
  let priorRunId = 'unidentified';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { buildRunId?: unknown };
    if (typeof manifest.buildRunId === 'string' && /^[A-Za-z0-9._-]+$/.test(manifest.buildRunId)) {
      priorRunId = manifest.buildRunId;
    }
  } catch {
    // Preserve malformed prior evidence as-is; it still must not remain the active success manifest.
  }
  const archiveDirectory = path.join('build', 'sbf-call-depth-archive',
    `${priorRunId}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  fs.mkdirSync(archiveDirectory, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(archiveDirectory, 'manifest.json'));
  for (const name of fs.readdirSync('build').filter(name => name.startsWith('escrow.'))) {
    const file = path.join('build', name);
    if (fs.statSync(file).isFile()) fs.copyFileSync(file, path.join(archiveDirectory, name));
  }
  fs.rmSync(manifestPath);
  return archiveDirectory;
}
function quarantineFailedElf(elfPath: string, runId: string): string | null {
  if (!fs.existsSync(elfPath)) return null;
  const directory = path.join('build', 'sbf-call-depth-refused', runId);
  fs.mkdirSync(directory, { recursive: true });
  const archivedPath = path.join(directory, path.basename(elfPath));
  try {
    fs.renameSync(elfPath, archivedPath);
  } catch (renameError) {
    try {
      fs.copyFileSync(elfPath, archivedPath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(elfPath);
    } catch (copyError) {
      fs.rmSync(elfPath, { force: true });
      throw new Error(`Could not preserve failed ELF at ${archivedPath}: ${String(renameError)}; ${String(copyError)}`);
    }
  }
  return archivedPath;
}
type SbfCompileProfile = 'ordinary' | 'qualified-sha256';
const ordinaryImports = ['sol_set_return_data','sol_get_clock_sysvar','sol_try_find_program_address',
  'sol_invoke_signed_c','sol_memcpy_','sol_memmove_','sol_memset_'];

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

type QualifiedSbfCompileResult = {
  tools: string;
  version: string;
  imports: string[];
  elfSha256: string;
  stack: {version:number;frameLimit:number;maxFrameBytes:number;functions:unknown[];objects:string[]};
  toolchain: Record<string,{path:string;invokedAs:string;sha256:string;version:string}>;
};

function compileSbfProfile(source: string, stem: string, profile: 'ordinary'): {tools:string;version:string};
function compileSbfProfile(source: string, stem: string, profile: 'qualified-sha256'): QualifiedSbfCompileResult;
function compileSbfProfile(source: string, stem: string, profile: SbfCompileProfile) {
  const tools = sbfTools();
  const clang = path.join(tools, 'clang');
  const linker = path.join(tools, 'ld.lld');
  const readelf = path.join(tools, 'llvm-readelf');
  const version = run(clang, ['--version'], true);
  if (!version.includes('20.1.7') || !version.includes('anza-xyz')) {
    throw new Error('Expected Anza platform-tools v1.53 clang 20.1.7; set SBF_TOOLS to its llvm/bin');
  }
  const linkerVersion = profile === 'qualified-sha256' ? run(linker,['--version'],true) : undefined;
  const readelfVersion = profile === 'qualified-sha256' ? run(readelf,['--version'],true) : undefined;
  if (profile === 'qualified-sha256' &&
      (!linkerVersion?.includes('20.1.7') || !linkerVersion.includes('anza-xyz') || !readelfVersion?.includes('20.1.7'))) {
    throw new Error('Qualified SHA build requires Anza platform-tools v1.53 LLD/readelf 20.1.7');
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
  const ordinaryStackReport = {version:1,frameLimit:4096,
    maxFrameBytes:Math.max(0,...usage.map(f=>f.bytes)),functions:usage};
  run(clang, [...flags, '-c', 'runtime/memory.c', '-o', `${stem}.memory.o`]);
  let stackReport: typeof ordinaryStackReport & {objects?: string[]};
  if (profile === 'qualified-sha256') {
    const stackFiles = [`${stem}.su`, `${stem}.memory.su`];
    const frames = stackFiles.flatMap(file => {
      if (!fs.existsSync(file)) throw new Error(`Qualified SHA build is missing Clang stack report ${file}`);
      const contents = fs.readFileSync(file, 'utf8').trim();
      if (!contents) throw new Error(`Qualified SHA build has an empty Clang stack report ${file}`);
      return contents.split('\n').map(line => {
        const [location, bytes, kind] = line.split('\t');
        if (!location || !/^\d+$/.test(bytes ?? '')) throw new Error(`Unexpected Clang stack-usage report row: ${line}`);
        if (kind !== 'static') throw new Error(`Qualified SHA build requires a static Clang stack marker: ${line}`);
        return {file, location:path.basename(location), bytes:Number(bytes), kind};
      });
    });
    const oversized = frames.filter(frame => frame.bytes > 4096);
    if (oversized.length) {
      throw new TargetDiagnostic('BEND-SBF203',
        `Qualified SHA SBF stack report exceeds 4096 bytes: ${oversized.map(f=>`${f.location}=${f.bytes}`).join(', ')}`,
        'Reduce per-call window size or live temporaries. SBF permits at most 4096 bytes per frame.');
    }
    stackReport = {version:1,frameLimit:4096,maxFrameBytes:Math.max(...frames.map(f=>f.bytes)),
      functions:frames,objects:stackFiles};
  } else {
    stackReport = ordinaryStackReport;
  }
  fs.writeFileSync(`${stem}.stack.json`,JSON.stringify(stackReport,null,2)+'\n');
  run(linker, ['-z', 'notext', '-shared', '--Bdynamic',
    'runtime/sbf.ld', '--entry', 'entrypoint', '-z', 'max-page-size=4096',
    '--gc-sections', `${stem}.o`, `${stem}.memory.o`, '-o', `${stem}.so`]);
  const checkedElfSha256Before = profile === 'qualified-sha256' ? sha256File(`${stem}.so`) : undefined;
  const symbols = run(readelf,['-s',`${stem}.so`],true);
  if (profile === 'qualified-sha256') {
    const header = run(readelf,['-h',`${stem}.so`],true);
    if (!/Class:\s+ELF64/.test(header) || !/Machine:\s+Solana Bytecode Format/.test(header) ||
        !/Flags:\s+0x0\b/.test(header)) {
      throw new Error('Qualified SHA final ELF must be ELF64 SBPFv0 (flags 0)');
    }
  }
  const imports = [...new Set(symbols.split('\n').filter(line => /\bUND\b/.test(line))
    .map(line => line.trim().split(/\s+/).at(-1)!).filter(symbol => symbol !== 'UND'))].sort();
  const allowed = new Set(profile === 'ordinary'
    ? ordinaryImports
    : [...ordinaryImports, 'abort', 'sol_sha256']);
  if (profile === 'qualified-sha256') {
    if (imports.includes('sol_log_64_')) throw new Error('Qualified SHA SBF forbids test observation import sol_log_64_');
    for (const required of ['abort', 'sol_sha256']) {
      if (!imports.includes(required)) throw new Error(`Qualified SHA SBF is missing required final ELF import: ${required}`);
    }
  }
  for (const symbol of imports) {
    if (!allowed.has(symbol)) throw new Error(`Unsupported SBF import: ${symbol}`);
  }
  if (profile === 'ordinary') return {tools,version};
  const checkedElfSha256After = sha256File(`${stem}.so`);
  if (checkedElfSha256Before !== checkedElfSha256After) {
    throw new Error('Qualified SHA final ELF changed during SBPFv0 header/import validation');
  }
  const toolchain = Object.fromEntries([['clang', clang], ['ld.lld', linker], ['llvm-readelf', readelf]].map(([name, file]) => {
    const resolved = fs.realpathSync(file);
    const toolVersion = name === 'clang' ? version : name === 'ld.lld' ? linkerVersion! : readelfVersion!;
    return [name, {path:resolved,invokedAs:path.resolve(file),sha256:sha256File(resolved),version:toolVersion.trim().replaceAll(/\s+/g,' ')}];
  }));
  return { tools, version, imports, elfSha256:checkedElfSha256After, stack:stackReport, toolchain };
}

/** Ordinary SBF profile. Its import allowlist and stack-report behavior stay unchanged. */
export function compileSbf(source: string, stem: string) {
  return compileSbfProfile(source, stem, 'ordinary');
}

/** Fixed internal profile used only after the source-qualified SHA build path. */
export function compileQualifiedShaSbf(source: string, stem: string) {
  return compileSbfProfile(source, stem, 'qualified-sha256');
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
  const buildRunId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const priorEvidenceArchive = archivePriorBuildEvidence();
  if (priorEvidenceArchive) console.log(`Archived prior build evidence in ${priorEvidenceArchive}`);
  fs.rmSync('build/manifest.json', { force: true });
  fs.rmSync('build/escrow.so', { force: true });
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
      'examples/escrow/PROOF.bend', 'compiler/backend.ts', 'compiler/tagged-sum-ir.ts', 'compiler/native-arithmetic.ts', 'compiler/diagnostics.ts', 'runtime/entrypoint.c',
      'runtime/solana_min.h', 'runtime/sbf.ld', 'scripts/build.ts', 'compiler/primitives.ts',
      'compiler/schema.ts', 'compiler/codecs.ts', 'compiler/dispatch.ts', 'compiler/artifacts.ts',
      'compiler/storage.ts', 'compiler/effects.ts', 'runtime/memory.c',
      ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => `compiler/${f}`)];
    const manifestBase = { bendCommit: BEND_COMMIT, compiler: version.split('\n')[0],
      priorEvidenceArchive,
      platformTools: 'v1.53', target: 'sbf', cpu: 'generic', sbpfVersion: 0, exports: ['escrow.release'],
      emittedFunctions: emitted.functions, inputs: Object.fromEntries(inputs.map(f => [f, hash(f)])),
      elfSha256: hash('build/escrow.so'), elfBytes: fs.statSync('build/escrow.so').size };
    const { result: manifest } = publishAcceptedFinalSbfArtifact(
      'build/escrow.so', 'build/sbf-call-depth', callDepth => {
        if (manifestBase.inputs[callDepth.checker.path] !== callDepth.checker.sha256) {
          throw new Error('SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH: receipt checker differs from the build input snapshot');
        }
        verifyFinalSbfArtifactReceipt(callDepth, 'build/escrow.so');
        if (callDepth.artifact.sha256 !== manifestBase.elfSha256 ||
            callDepth.artifact.byteLength !== manifestBase.elfBytes) {
          throw new Error('SBF_CALL_DEPTH_ELF_HASH_MISMATCH: call-depth receipt differs from the final build ELF');
        }
        const publishedManifest = { ...manifestBase, buildRunId, sbfCallDepth: callDepth };
        const manifestTemporary = `build/manifest.${callDepth.runId}.tmp`;
        fs.writeFileSync(manifestTemporary, JSON.stringify(publishedManifest, null, 2) + '\n');
        fs.renameSync(manifestTemporary, 'build/manifest.json');
        return publishedManifest;
      }, { buildRunId });
    console.log(`Built build/escrow.so (${manifest.elfBytes} bytes; SBPFv0)`);
  } catch (e) {
    const archivedElf = quarantineFailedElf('build/escrow.so', buildRunId);
    const detail = describeError(e);
    throw new Error(`${detail}${archivedElf ? `; failed ELF archived at ${archivedElf}` : ''}`);
  }
}
if (import.meta.main) await build();
