import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareBend, BEND_COMMIT } from '../scripts/build.ts';
prepareBend();
const { model } = await import('./model.ts');
const { checkedBook } = await import('../compiler/backend.ts');
const B = await import('../.deps/bend/bend2/bend.ts');
fs.mkdirSync('build', { recursive: true });
const mathPath = 'build/sqrt-refinement.math.model.json';
const widePath = 'build/sqrt-refinement.wide.model.json';
fs.writeFileSync(mathPath, JSON.stringify(await model('sdk/math.bend', ['mul32_parts','mul32','mul_parts','mul'])));
fs.writeFileSync(widePath, JSON.stringify(await model('sdk/wide.bend', ['add','product_parts','product'])));
const roots = ['floor', 'geometric_mean'];
async function check(source: string, stem: string, status: number) {
  fs.writeFileSync(stem + '.model.json', JSON.stringify(await model(source, roots)));
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/sqrt.py', stem + '.model.json', mathPath, widePath], { encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.claims.length, 69);
  assert(report.claims.every((c: any) => ['sat', 'unsat'].includes(c.result)), 'UNKNOWN cannot pass');
  assert.equal(report.binding.result, 'checked');
  assert.equal(report.multiplication.claims.length, 14);
  assert(report.multiplication.claims.every((c: any) => c.result === 'unsat'));
  assert(report.checkedHelpers.every((c: any) => c.result === 'unsat'));
  if (status === 0) assert.equal(report.checkedHelpers.length, 3);
  if (status === 0) assert(report.claims.every((c: any) => c.result === 'unsat'));
  else assert(report.claims.some((c: any) => c.result === 'sat'));
  return report;
}
const positive = await check('sdk/sqrt.bend', 'build/sqrt-refinement', 0);
const source = fs.readFileSync('sdk/sqrt.bend', 'utf8');
const mutations = [];
// Mutant files stay alongside the source so module names and relative imports
// remain identical to the checked model used by the positive proof.
const path = `sdk/.sqrt-negative-${process.pid}.bend`;
const constructor = (name: string, ...args: any[]) => B.Ctr(name, args);
const u32 = (n: bigint) => B.term_higher(B.u32_to_term(Number(n)));
const word = (n: bigint) => constructor('math.U64', u32(n & 0xffffffffn), u32(n >> 32n));
const wide = (n: bigint) => constructor('wide.U128', word(n & ((1n << 64n)-1n)), word(n >> 64n));
function plain(term: any): any {
  assert.equal(term.$, 'Ctr');
  return term.k === 'U32' ? B.u32_from_term(term) : { constructor: term.k, fields: term.x.map(plain) };
}
try {
  for (const [name, before, after] of [
    ['inverted comparison', 'Bool.not(less(target, Wide.product(candidate, candidate)))', 'less(target, Wide.product(candidate, candidate))'],
    ['discard accepted bit', 'Search{target, candidate, half(bit)}', 'Search{target, root, half(bit)}'],
    ['bit never advances', 'half(bit)', 'bit'],
    ['incorrect candidate', 'Math.add_wrap(root, bit)', 'Math.add_wrap(root, root)'],
  ]) {
    assert(source.includes(before));
    fs.writeFileSync(path, source.replaceAll(before, after));
    const report = await check(path, `build/sqrt-negative-${mutations.length}`, 1);
    assert.equal(report.claims.find((c: any) => c.claim === 'sqrt-checked-step').result, 'sat');
    const book = await checkedBook(path);
    const input = constructor('Search', wide(9n), word(2n), word(1n));
    const actual = plain(B.term_snf(book, B.App(B.Ref('step'), input)));
    const expected = plain(constructor('Search', wide(9n), word(3n), word(0n)));
    assert.notDeepEqual(actual, expected);
    mutations.push({ name, report, concreteWitness: { target: '9', root: '2', bit: '1', actual, expected } });
  }
  fs.writeFileSync(path, source.replace('Math.U64{0, 2147483648}', 'Math.U64{0, 1073741824}'));
  const wrapper = await check(path, 'build/sqrt-negative-wrapper', 1);
  assert.equal(wrapper.claims.find((c: any) => c.claim === 'sqrt-floor-wrapper').result, 'sat');
  // Full-range witness: omitting the top trial bit cannot represent 2^63.
  const book = await checkedBook(path);
  const actual = plain(B.term_snf(book, B.App(B.Ref('floor'), wide(1n << 126n))));
  const expected = plain(word(1n << 63n));
  assert.notDeepEqual(actual, expected);
  mutations.push({ name: 'missing initial top bit', report: wrapper, concreteWitness: { target: (1n << 126n).toString(), actual, expected } });
  fs.writeFileSync(path, source.replace('step32(step32(state))', 'step32(state)'));
  fs.writeFileSync('build/sqrt-negative-composition.model.json', JSON.stringify(await model(path, roots)));
  const skipped = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/sqrt.py', 'build/sqrt-negative-composition.model.json', mathPath, widePath], { encoding: 'utf8' });
  assert.notEqual(skipped.status, 0); assert.match(skipped.stderr, /step64 must apply step32 twice/);
  const corrupted = JSON.parse(fs.readFileSync('build/sqrt-refinement.model.json', 'utf8'));
  corrupted.functions['wide.product'].body = null;
  fs.writeFileSync('build/sqrt-negative-binding.model.json', JSON.stringify(corrupted));
  const mismatch = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/sqrt.py', 'build/sqrt-negative-binding.model.json', mathPath, widePath], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /Imported product definition mismatch/);
  // A false helper contract must prevent the summarized step proof from running.
  fs.writeFileSync(path, source.replace('U32.div(hi, 2)', 'U32.div(hi, 1)'));
  fs.writeFileSync('build/sqrt-negative-helper.model.json', JSON.stringify(await model(path, roots)));
  const helper = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/sqrt.py', 'build/sqrt-negative-helper.model.json', mathPath, widePath], { encoding: 'utf8' });
  assert.notEqual(helper.status, 0); assert.match(helper.stderr, /Square-root helper proof failed/);
  assert.match(helper.stderr, /sqrt-helper-half.*sat/);
} finally { fs.rmSync(path, { force: true }); }
const files = ['sdk/sqrt.bend','sdk/math.bend','sdk/wide.bend','compiler/primitives.ts','compiler/backend.ts','compiler/schema.ts','package.json','package-lock.json',
  'verification/model.ts','verification/prove.py','verification/multiplication.py',
  'verification/division_loop.py','verification/vesting_process.py','verification/sqrt.py','verification/check-sqrt.ts'];
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
fs.writeFileSync('build/sqrt-refinement.json', JSON.stringify({ bendCommit: BEND_COMMIT, positive, mutations,
  skippedCompositionRejected: true, importedProductMismatchRejected: true, incorrectHelperRejected: true, hashes }, null, 2) + '\n');
console.log('Square-root refinement: 69 obligations, five SAT mutations with concrete Bend witnesses, composition and import negatives passed');
