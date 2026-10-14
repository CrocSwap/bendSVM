import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as B from '../.deps/bend/bend2/bend.ts';
import { Backend, checkedBook, mangle } from '../compiler/backend.ts';
import { primitives } from '../compiler/primitives.ts';
import { compileSbf, run } from '../scripts/build.ts';

export async function testMathProofs() {
  await checkedBook('sdk/PROOF.bend');
  const mutations = [
    ['addition overflow accepted', 'case True{}:\n      Err{1}', 'case True{}:\n      Ok{sum}'],
    ['subtraction underflow accepted', 'case True{}:\n      Err{2}', 'case True{}:\n      Ok{sub_wrap(a, b)}'],
    ['zero divisor accepted', 'case True{}:\n      DivErr{3}', 'case True{}:\n      DivOk{Division{zero(), zero()}}'],
  ];
  for (const [label, from, to] of mutations) {
    const dir = fs.mkdtempSync(path.resolve('build/math-negative-'));
    try {
      for (const file of ['math.bend', 'LAWS.bend', 'PROOF.bend']) {
        let source = fs.readFileSync(`sdk/${file}`, 'utf8');
        if (file === 'math.bend') { assert(source.includes(from)); source = source.replace(from, to); }
        fs.writeFileSync(path.join(dir, file), source);
      }
      await assert.rejects(() => checkedBook(path.join(dir, 'PROOF.bend')), /expected|observed/, label);
    } finally { fs.rmSync(dir, { recursive: true }); }
  }
  console.log('Six SDK arithmetic guard laws checked; three broken implementations rejected');
}

export async function testArithmetic() {
  await testMathProofs();
  const book = await checkedBook('tests/arithmetic.bend');
  const names = Object.keys(primitives);
  const wide = ['add64', 'sub64', 'less64', 'equal64', 'mul64', 'div64', 'mod64'];
  const roots = [...names, ...wide];
  const emitted = new Backend(book).emit(roots);
  fs.writeFileSync('build/arithmetic.h', emitted.c);
  const arms = names.map((name, op) => {
    const primitive = primitives[name];
    const args = ['al', 'ah'].slice(0, primitive.args.length);
    const boolGuard = primitive.args.flatMap((type, i) => type === 'Bool' ? [`${args[i]} > 1u`] : []);
    return `case ${op}: ${boolGuard.length ? `if (${boolGuard.join(' || ')}) break;` : ''}
      *lo = ${mangle(name)}(${args.join(', ')}); return;`;
  });
  for (const [i, name] of wide.entries()) arms.push(i === 2 || i === 3
    ? `case ${names.length + i}: *lo = ${mangle(name)}(al, ah, bl, bh); return;`
    : `case ${names.length + i}: { bend_Reply_t r = ${mangle(name)}(al, ah, bl, bh);
      *error = r.as.c0.f0; *lo = r.as.c0.f1; *hi = r.as.c0.f2; return; }`);
  // A test-only wire harness. It has no arithmetic implementation of its own.
  fs.writeFileSync('build/arithmetic-dispatch.h', `#include "arithmetic.h"
static void dispatch(unsigned op, unsigned al, unsigned ah, unsigned bl, unsigned bh,
    unsigned *error, unsigned *lo, unsigned *hi) {
  *error = 0; *lo = 0; *hi = 0;
  switch (op) { ${arms.join('\n')} }
  *error = 9;
}\n`);
  fs.writeFileSync('build/arithmetic-native.c', `#include <stdio.h>
#include "arithmetic-dispatch.h"
int main(void) {
  unsigned op, al, ah, bl, bh, error, lo, hi;
  while (scanf("%u %u %u %u %u", &op, &al, &ah, &bl, &bh) == 5) {
    dispatch(op, al, ah, bl, bh, &error, &lo, &hi);
    printf("%u %u %u\\n", error, lo, hi);
  }
  return ferror(stdin) ? 1 : 0;
}\n`);
  fs.writeFileSync('build/arithmetic-sbf.c', `#include "solana_min.h"
#include "arithmetic-dispatch.h"
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 0 || read_le(input + 8, 8) != 17) return 1;
  const u8 *p = input + 16;
  unsigned error, lo, hi;
  dispatch(p[0], (u32)read_le(p+1, 4), (u32)read_le(p+5, 4),
    (u32)read_le(p+9, 4), (u32)read_le(p+13, 4), &error, &lo, &hi);
  u8 out[12]; write_le(out, error, 4); write_le(out+4, lo, 4); write_le(out+8, hi, 4);
  sol_set_return_data(out, 12); return 0;
}\n`);
  const evaluate = (name: string, args: number[], bools: boolean[] = []) => {
    let term: B.HTerm = B.Ref(name);
    for (const [i, arg] of args.entries()) term = B.App(term, bools[i]
      ? B.Ctr(arg ? 'True' : 'False', []) : B.term_higher(B.u32_to_term(arg)));
    return B.term_snf(book, term);
  };
  const number = (t: B.HTerm): number => {
    if (t.$ === 'Ctr' && (t.k === 'True' || t.k === 'False')) return Number(t.k === 'True');
    const n = B.u32_from_term(t);
    assert.notEqual(n, null); return n!;
  };
  const cases: { name: string; input: number[]; expected: number[] }[] = [];
  const boundary = [0, 1, 2, 31, 65535, 65536, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
  let seed = 0x63a51bf2;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (const [op, name] of names.entries()) {
    const types = primitives[name].args;
    const pairs = boundary.flatMap(a => boundary.map(b => [a, b]));
    for (let i = 0; i < 16; i++) pairs.push([random(), random()]);
    const seen = new Set<string>();
    for (const pair of pairs) {
      const args = pair.slice(0, types.length).map((v, i) => types[i] === 'Bool' ? v & 1 : v);
      const key = args.join(','); if (seen.has(key)) continue; seen.add(key);
      const expected = number(evaluate(name, args, types.map(t => t === 'Bool')));
      cases.push({ name, input: [op, args[0], args[1] ?? 0, 0, 0], expected: [0, expected, 0] });
    }
  }
  const max = (1n << 64n) - 1n;
  const amounts = [0n, 1n, 2n, (1n << 32n) - 1n, 1n << 32n, (1n << 32n) + 1n,
    (1n << 63n) - 1n, 1n << 63n, max - 1n, max];
  const pairs = amounts.flatMap(a => amounts.map(b => [a, b]));
  // Both sides of the 32-step guard when the divisor fits in one limb.
  pairs.push([(7n << 32n) + 123n, 8n], [(8n << 32n) + 123n, 8n],
    [(65534n << 32n) + 123n, 65535n], [(65535n << 32n) + 123n, 65535n]);
  for (let i = 0; i < 32; i++) pairs.push([(BigInt(random()) << 32n) | BigInt(random()),
    (BigInt(random()) << 32n) | BigInt(random())]);
  const limbs = (n: bigint) => [Number(n & 0xffffffffn), Number(n >> 32n)];
  for (const [pairIndex, [a, b]] of pairs.entries()) {
    if (pairIndex % 16 === 0) console.log(`Checking u64 reference arithmetic: pair ${pairIndex + 1}/${pairs.length}`);
    for (const [i, name] of wide.entries()) {
    const args = [...limbs(a), ...limbs(b)];
    const reference = evaluate(name, args);
    const expected = i !== 2 && i !== 3 && reference.$ === 'Ctr' ? reference.x.map(number) : [0, number(reference), 0];
    let oracle: number[];
    if (i === 0) oracle = a + b > max ? [1, 0, 0] : [0, ...limbs(a + b)];
    else if (i === 1) oracle = a < b ? [2, 0, 0] : [0, ...limbs(a - b)];
    else if (i === 2 || i === 3) oracle = [0, Number(i === 2 ? a < b : a === b), 0];
    else if (i === 4) oracle = a * b > max ? [1, 0, 0] : [0, ...limbs(a * b)];
    else oracle = b === 0n ? [3, 0, 0] : [0, ...limbs(i === 5 ? a / b : a % b)];
    assert.deepEqual(expected, oracle, `Bend SDK vs BigInt: ${name}(${a}, ${b})`);
    cases.push({ name, input: [names.length + i, ...args], expected });
    }
  }
  // Tests of wire dispatch rejection, not valid Bend values.
  cases.push({ name: 'invalid_opcode', input: [255, 0, 0, 0, 0], expected: [9, 0, 0] });
  cases.push({ name: 'invalid_bool', input: [names.indexOf('Bool.not'), 2, 0, 0, 0], expected: [9, 0, 0] });
  run(process.env.CC ?? 'clang', ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror',
    '-fsanitize=undefined', '-fno-sanitize-recover=all', 'build/arithmetic-native.c', '-o', 'build/arithmetic-native']);
  const native = spawnSync(path.resolve('build/arithmetic-native'), [], { encoding: 'utf8',
    input: cases.map(c => c.input.join(' ')).join('\n') + '\n' });
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(native.stdout.trim().split('\n'), cases.map(c => c.expected.join(' ')));
  compileSbf('build/arithmetic-sbf.c', 'build/arithmetic');
  const wire = cases.map(c => {
    const input = Buffer.alloc(17); input[0] = c.input[0];
    for (let i = 0; i < 4; i++) input.writeUInt32LE(c.input[i + 1], 1 + i * 4);
    const expected = Buffer.alloc(12); c.expected.forEach((v, i) => expected.writeUInt32LE(v, i * 4));
    return { name: c.name, input: [...input], expected: [...expected] };
  });
  fs.writeFileSync('build/arithmetic-vectors.json', JSON.stringify(wire) + '\n');
  console.log(`${cases.length} arithmetic reference/native cases passed (including ${pairs.length * wide.length} u64/BigInt cases); SBF probe built`);
}
