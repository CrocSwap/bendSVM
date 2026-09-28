import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build, run } from './build.ts';

await build();
const B = await import('../.deps/bend/bend2/bend.ts');
const { checkedBook, Backend, describeError } = await import('../compiler/backend.ts');
const book = await checkedBook('examples/escrow/PROOF.bend');
const vectors: { authorized: boolean; tag: number; lo: number; hi: number;
  expected_tag: number; expected_lo: number; expected_hi: number }[] = [];
const amounts: [number, number][] = [[0, 0], [1, 0], [0xffffffff, 0], [0, 1],
  [0xffffffff, 0x7fffffff], [0, 0x80000000], [0xffffffff, 0xffffffff]];
let seed = 0x5bfe1234;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
for (let i = 0; i < 25; i++) amounts.push([random(), random()]);
for (const authorized of [false, true]) for (const tag of [0, 1]) for (const [lo, hi] of amounts) {
  const amount = B.Ctr<B.HBody>('escrow.Amount', [B.term_higher(B.u32_to_term(lo)), B.term_higher(B.u32_to_term(hi))]);
  const state = B.Ctr<B.HBody>(tag ? 'escrow.Released' : 'escrow.Locked', [amount]);
  const call = B.App(B.App(B.Ref<B.HBody>('escrow.release'), B.Ctr<B.HBody>(authorized ? 'True' : 'False', [])), state);
  const result = B.term_snf(book, call);
  assert.equal(result.$, 'Ctr');
  if (result.$ !== 'Ctr' || result.x[0].$ !== 'Ctr') throw new Error('Unexpected reference result');
  const limbs = result.x[0].x.map(x => B.u32_from_term(x));
  assert(limbs.every(v => v !== null));
  vectors.push({ authorized, tag, lo, hi, expected_tag: result.k === 'escrow.Released' ? 1 : 0,
    expected_lo: limbs[0]!, expected_hi: limbs[1]! });
}
fs.writeFileSync('build/vectors.json', JSON.stringify(vectors, null, 2) + '\n');
run(process.env.CC ?? 'clang', ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror',
  '-Ibuild', 'tests/native.c', '-o', 'build/native']);
const native = spawnSync(path.resolve('build/native'), [], { encoding: 'utf8',
  input: vectors.map(v => `${Number(v.authorized)} ${v.tag} ${v.lo} ${v.hi}`).join('\n') + '\n' });
assert.equal(native.status, 0, native.stderr);
assert.deepEqual(native.stdout.trim().split('\n'), vectors.map(v => `${v.expected_tag} ${v.expected_lo} ${v.expected_hi}`));
console.log(`${vectors.length} Bend reference/native C differential cases passed`);

// A second source guards against accidentally specializing the backend to the
// escrow example: constructor field permutation, nested calls, locals, literals.
const selection = new Backend(await checkedBook('tests/selection.bend')).emit(['select', 'maximum', 'locals']);
fs.writeFileSync('build/selection.h', selection.c);
fs.writeFileSync('build/selection.c', `#include "selection.h"
int main(void) {
  bend_Duo_t pair = bend_Duo_make(17, 42);
  bend_Duo_t same = bend_locals(pair);
  return !(bend_select(0, pair) == 17 && bend_select(1, pair) == 42 &&
    bend_maximum() == 4294967295u && same.as.c0.f0 == 17 && same.as.c0.f1 == 42);
}\n`);
run(process.env.CC ?? 'clang', ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', 'build/selection.c', '-o', 'build/selection']);
run(path.resolve('build/selection'), []);
console.log('Independent record/selection/literal/let backend fixture passed');

const rejects: string[] = [];
async function rejectsProof(label: string, mutate: (files: Record<string, string>) => void, expected?: RegExp) {
  const dir = fs.mkdtempSync(path.resolve('build/negative-'));
  try {
    const files: Record<string, string> = Object.fromEntries(['escrow.bend', 'LAWS.bend', 'PROOF.bend']
      .map(f => [f, fs.readFileSync(`examples/escrow/${f}`, 'utf8')]));
    mutate(files);
    for (const [f, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), contents);
    await assert.rejects(async () => {
      try { await checkedBook(path.join(dir, 'PROOF.bend')); }
      catch (e) { throw new Error(describeError(e)); }
    }, expected, label);
    rejects.push(label);
  } finally { fs.rmSync(dir, { recursive: true }); }
}
await rejectsProof('unauthorized release', f => { f['escrow.bend'] = f['escrow.bend'].replace('      escrow\n', '      release_allowed(escrow)\n'); });
await rejectsProof('authorized release disabled', f => { f['escrow.bend'] = f['escrow.bend'].replaceAll('Released{amount}\n', 'Locked{amount}\n'); });
await rejectsProof('amount replaced with zero', f => { f['escrow.bend'] = f['escrow.bend'].replace('      Released{amount}', '      Released{Amount{0, 0}}'); });
await rejectsProof('proof hole', f => { f['PROOF.bend'] = f['PROOF.bend'].replace('{==}', '?TODO'); }, /holes|open laws/);
await rejectsProof('missing proof', f => { f['PROOF.bend'] = f['PROOF.bend'].slice(0, f['PROOF.bend'].indexOf('def Laws.release_idempotent')); }, /holes|open laws/);
await rejectsProof('unsafe dependency', f => { f['escrow.bend'] = f['escrow.bend'].replace('def release(', '@unsafe def release('); }, /Unsafe\/foreign/);
await rejectsProof('laws bypassed', f => { f['PROOF.bend'] = 'import ./escrow.bend as Escrow\n'; }, /must import/);

const unsupported = [
  ['higher-order', 'import Base\ndef apply(f: U32 -> U32, x: U32) -> U32:\n  f(x)\n', 'apply', /runtime type/],
  ['recursive data', 'type Chain is Data:\n  End{}\n  Next{tail: Chain}\ndef identity(n: Chain) -> Chain:\n  n\n', 'identity', /Recursive data/],
  ['floating point', 'import Base\ndef identity(n: F32) -> F32:\n  n\n', 'identity', /runtime type/],
  ['primitive spoofing', 'type U32 is Data:\n  Fake{}\ndef identity(n: U32) -> U32:\n  n\n', 'identity', /pinned Base/],
] as const;
for (const [label, source, root, pattern] of unsupported) {
  const file = `build/unsupported-${root}-${rejects.length}.bend`;
  fs.writeFileSync(file, source);
  await assert.rejects(async () => new Backend(await checkedBook(file)).emit([root]), pattern, label);
  fs.unlinkSync(file); rejects.push(label);
}
// Artifact checks: only the whitelisted syscall remains unresolved; no mutable
// program data, and the header contains neither proof functions nor a runtime.
const elf = fs.readFileSync('build/elf.txt', 'utf8');
assert.match(elf, /Flags:\s+0x0/);
assert.doesNotMatch(elf, /\s\.(?:bss|data)\s/);
const imports = [...new Set(elf.split('\n').filter(l => /\bUND\b/.test(l))
  .map(l => l.trim().split(/\s+/).at(-1)).filter(s => s !== 'UND'))];
assert.deepEqual(imports, ['sol_set_return_data']);
assert.doesNotMatch(fs.readFileSync('build/escrow.h', 'utf8'), /Laws|pthread|malloc|CORPUS/);
console.log(`${rejects.length} negative proof/backend tests passed`);
fs.writeFileSync('build/checks.json', JSON.stringify({ reference_native_cases: vectors.length, rejected: rejects,
  imports, mutable_program_data: false }, null, 2) + '\n');
await (await import('../tests/batch.ts')).testBatch();
await (await import('../tests/fold.ts')).testFold();
await (await import('../tests/effect-buffer.ts')).testEffectBuffer();
await (await import('../tests/iteration.ts')).testIteration();
await (await import('../tests/buffer.ts')).testBuffer();
await (await import('../tests/collection.ts')).testCollection();
await (await import('../tests/collection-store.ts')).testCollectionStore();
await (await import('../tests/queue.ts')).testQueue();
await (await import('../tests/diagnostics.ts')).testDiagnostics();
run(process.env.CC??'clang',['-std=c17','-O1','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
  '-fno-sanitize-recover=all','-Iruntime','tests/collection-runtime.c','-o','build/collection-runtime']);
run('build/collection-runtime',[]);
await (await import('../tests/generics.ts')).testGenerics();
await (await import('../tests/codecs.ts')).testCodecs();
await (await import('../tests/storage.ts')).testStorage();
await (await import('../tests/multi-storage.ts')).testMultiStorage();
await (await import('../tests/cpi.ts')).testCpi();
await (await import('../tests/token-three.ts')).testTokenThree();
await (await import('../tests/token-issuance.ts')).testTokenIssuance();
await (await import('../tests/vault.ts')).testVault();
await (await import('../tests/wide.ts')).testWide();
await (await import('../tests/vesting.ts')).testVesting();
await (await import('../tests/exchange.ts')).testExchange();
await (await import('../tests/amm-pricing.ts')).testAmmPricing();
await (await import('../tests/amm.ts')).testAmm();
await (await import('../tests/sqrt.ts')).testSqrt();
await (await import('../tests/arithmetic.ts')).testArithmetic();
await (await import('../tests/builds.ts')).testBuilds();
await import('./test-lowering.ts');
run('cargo', ['test', '--locked', '--test', 'sbf', '--', '--nocapture']);
