import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { run, sbfTools } from './build.ts';

const tools = sbfTools();
const rustc = path.resolve(tools, '../../rust/bin/rustc');
const version = run(rustc, ['--version', '--verbose'], true);
assert(version.includes('1.89.0-dev') && version.includes('LLVM version: 20.1.7'),
  'Expected the Rust compiler shipped with Anza platform-tools v1.53');
fs.mkdirSync('build', { recursive: true });
// The installed legacy target has SBF v0 ELF flags, matching clang's generic
// target. The newer sbpfv0 name is listed by rustc but has no installed core.
const flags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort'];
const source = 'benchmarks/batch-rust/main.rs';
const elf = 'build/batch-rust.so';
run(rustc, [...flags, source, '-o', elf]);
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const first = hash(elf);
run(rustc, [...flags, source, '-o', elf]);
assert.equal(hash(elf), first, 'Rust baseline rebuild must be byte-identical');
const header = run(path.join(tools, 'llvm-readelf'), ['-h', elf], true);
assert.match(header, /Flags:\s+0x0\b/, 'Expected SBF v0 ELF');
const symbols = run(path.join(tools, 'llvm-readelf'), ['-s', elf], true);
const allowed = new Set(['abort', 'sol_set_return_data', 'sol_get_clock_sysvar',
  'sol_try_find_program_address', 'sol_invoke_signed_c', 'sol_memcpy_', 'sol_memmove_', 'sol_memset_', 'sol_memcmp_']);
for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
  const symbol = line.trim().split(/\s+/).at(-1)!;
  assert(symbol === 'UND' || allowed.has(symbol), `Unexpected Rust SBF import: ${symbol}`);
}
const files = ['main.rs', 'transition.rs', 'wire.rs'].map(name => `benchmarks/batch-rust/${name}`);
files.push('scripts/build-batch-rust.ts', 'Cargo.lock');
fs.writeFileSync('build/batch-rust.manifest.json', JSON.stringify({
  version, flags, target: 'SBF v0 / generic', elf, elfBytes: fs.statSync(elf).size,
  elfSha256: first, reproducible: true,
  sources: Object.fromEntries(files.map(file => [file, hash(file)])),
}, null, 2) + '\n');
console.log(`Rust batch SBF: ${fs.statSync(elf).size} bytes; byte-identical rebuild passed`);
